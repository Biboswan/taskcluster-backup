let _ = require('lodash');
let Promise = require('bluebird');
let zstd = require('node-zstd');
let symbols = require('./symbols');

let getAccounts = async (auth, included, ignored) => {
  let accounts = included;
  if (accounts.length === 0) {
    console.log('No accounts in config. Loading accounts from auth service...');
    accounts = (await auth.azureAccounts()).accounts;
  }
  console.log(`Full list of available accounts: ${JSON.stringify(accounts)}`);
  let extraIgnored = _.difference(ignored, accounts);
  if (extraIgnored.length !== 0) {
    throw new Error(`
      Ignored acccounts ${JSON.stringify(extraIgnored)} are not in set ${JSON.stringify(accounts)}. Aborting.
    `);
  }
  return _.difference(accounts, ignored);
};

let getTables = async (auth, account, included, ignored) => {
  let tables = included.filter(table => table.startsWith(account + '/')).map(table => table.split('/')[1]);
  if (tables.length === 0) {
    console.log(`No tables in config for account ${account}. Loading tables from auth service...`);
    let accountParams = {};
    do {
      let resp = await auth.azureTables(account, accountParams);
      accountParams.continuationToken = resp.continuationToken;
      tables = tables.concat(resp.tables);
    } while (accountParams.continuationToken);
  }

  let ignoreTables = ignored.filter(table => table.startsWith(account + '/')).map(table => table.split('/')[1]);
  let extraIgnored = _.difference(ignoreTables, tables);
  if (extraIgnored.length !== 0) {
    throw new Error(`
      Ignored tables ${JSON.stringify(extraIgnored)} are not tables in ${JSON.stringify(tables)}. Aborting.
    `);
  }
  return _.difference(tables, ignoreTables);
};

let backupTables = async ({auth, s3, azure, bucket, accounts, include, ignore, concurrency, monitor}) => {
  console.log('Beginning table backup.');
  console.log('Including tables: ' + JSON.stringify(include.tables));
  console.log('Ignoring tables: ' + JSON.stringify(ignore.tables));

  let tables = [];
  await Promise.each(accounts, async account => {
    let ts = await getTables(auth, account, include.tables, ignore.tables);
    tables = tables.concat(ts.map(t => [account, t]));
  });
  console.log('Backing up tables: ' + JSON.stringify(tables));

  console.log(`Backing up ${tables.length} tables`);
  monitor.count('tables', tables.length);

  await monitor.timer('table-backup', Promise.map(tables, async (pair, index) => {
    let [account, tableName] = pair;
    let count = 0;
    return monitor.timer(`backup-${account}.${tableName}`, async () => {
      let symbol = symbols.choose(index);
      console.log(`\nBeginning backup of ${account}/${tableName} with symbol ${symbol}`);

      let stream = new zstd.compressStream();

      let table = new azure.Table({
        accountId: account,
        sas: async _ => {
          return (await auth.azureTableSAS(account, tableName, 'read-only')).sas;
        },
      });

      // Versioning is enabled in the backups bucket so we just overwrite the
      // previous backup every time. The bucket is configured to delete previous
      // versions after N days, but the current version will never be deleted.
      let upload = s3.upload({
        Bucket: bucket,
        Key: `${account}/${tableName}`,
        Body: stream,
        StorageClass: 'STANDARD_IA',
      }).promise();

      let processEntities = entities => entities.map(entity => {
        stream.write(JSON.stringify(entity) + '\n');
      });

      let tableParams = {};
      do {
        let results = await table.queryEntities(tableName, tableParams);
        tableParams = _.pick(results, ['nextPartitionKey', 'nextRowKey']);
        processEntities(results.entities);
        symbols.write(symbol);
        count += results.entities.length;
      } while (tableParams.nextPartitionKey && tableParams.nextRowKey);

      stream.end();
      await upload;
      console.log(`\nFinishing backup of ${account}/${tableName} with ${count} entities (${symbol})`);
    });
  }, {concurrency}));
};

module.exports = {
  run: async ({auth, s3, azure, bucket, include, ignore, concurrency, monitor}) => {
    monitor.count('begin');
    symbols.setup();

    let timedisp = setInterval(_ => {
      console.log(`\n\nCurrent Time: ${new Date}\n`);
    }, 60 * 1000);

    console.log('Beginning backup.');
    let accounts = await getAccounts(auth, include.accounts, ignore.accounts);
    console.log('Ignoring accounts: ' + JSON.stringify(ignore.accounts));
    console.log('Including accounts: ' + JSON.stringify(include.accounts));
    console.log('Backing up accounts: ' + JSON.stringify(accounts));

    await monitor.timer('total-backup', Promise.all([
      backupTables({auth, s3, azure, bucket, accounts, include, ignore, concurrency, monitor}),
    ]));

    console.log('\nFinished backup.');
    monitor.count('end');
    monitor.stopResourceMonitoring();
    await monitor.flush();
    clearInterval(timedisp);
    console.log('Finished cleanup.');
  },
};
