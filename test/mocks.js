let _ = require('lodash');
let Promise = require('promise');
let streamifier = require('streamifier');

module.exports = {};

let entities = {};

class mockS3 {
  constructor() {
    this.things = {};
  }

  upload({Bucket, Key, Body, StorageClass}) {
    this.things[Bucket + Key] = Buffer.alloc(0);
    Body.on('data', chunk => {
      this.things[Bucket + Key] = Buffer.concat([this.things[Bucket + Key], chunk]);
    });

    let finished = new Promise((resolve, reject) => {
      Body.on('end', _ => {
        resolve();
      });
    });
    return {promise: _ => finished};
  }

  getObject({Bucket, Key}) {
    return {
      createReadStream: () => {
        return streamifier.createReadStream(this.things[Bucket + Key]);
      },
    };
  }
}

class mockAuth {
  azureTableSAS(account, tableName, level) {
    return {sas: 'foo123'};
  }
  azureAccounts() {
    return {accounts: _.keys(entities)};
  }
  azureTables(account) {
    return {tables: _.keys(entities[account])};
  }
}

let mockAzure = {
  setEntities(account, tableName, rows) {
    entities[account] = entities[account] || {};
    entities[account][tableName] = rows || [];
  },
  resetEntities() {
    entities = {};
  },
  getEntities() {
    return entities;
  },
  addAccounts(accounts) {
    _.forEach(accounts, account => {
      entities[account] = {};
    });
  },
  Table: class {

    constructor({accountId}) {
      this.account = accountId;
    }

    // We abuse tableParams.nextRowKey since it is opaque to
    // the consumer anyway and just use it as an index into
    // the array.
    async queryEntities(tableName, tableParams) {
      let queried = entities[this.account][tableName] || [];
      let top = tableParams.top || 10; // We set this to 10 for testing
      let rowKey = tableParams.nextRowKey || 0;
      let end = top + rowKey;
      let nextRowKey;
      if (end > queried.length) {
        end = queried.length;
      } else {
        nextRowKey = end;
      }
      let results = {
        entities: _.slice(queried, rowKey, end),
      };
      if (nextRowKey) {
        results.nextPartitionKey = 'whatever';
        results.nextRowKey = nextRowKey;
      }
      return results;
    }

    async createTable(tableName) {
      entities[this.account][tableName] = [];
    }

    async insertEntity(tableName, entity) {
      entities[this.account][tableName].push(entity);
    }
  },
};

module.exports = {s3: mockS3, auth: mockAuth, azure: mockAzure};
