const { namespaceWrapper } = require('../namespaceWrapper');

/**
 * Data class
 *
 * @param {string} name - the name of the database
 * @param {object} data - the initial data to be stored in the database
 *
 * @returns {Data} - a Data object
 *
 */

class Data {
  constructor(name, data) {
    this.name = name;
    this.data = data;
    this.dbprefix = `${name} + ":"`;
    this.fullList = [];
    this.lastUpdate = Date.now();
  }

  /**
   * initializeData
   * @returns {void}
   */
  async initializeData() {
    if (this.db) return;
    const db = await namespaceWrapper.getDb();
    this.db = db;
  }

  /**
   * create and insert an item into the database
   * Old items with the lower timestamp will be removed
   * @param {*} item
   * @returns {void}
   */
  async create(item) {
    try {
      const existingItem = await this.getItem(item);
      console.log('get item', existingItem);

      if (existingItem) {
        if (
          !existingItem.timestamp ||
          (item.timestamp && item.timestamp > existingItem.timestamp)
        ) {
          // Remove the old item with the same ID
          await this.db.remove({ id: item.id }, {});
          console.log('Old item removed');
        } else {
          console.log('New item has a lower or equal timestamp; ignoring');
          return undefined;
        }
      }

      await this.db.insert(item);
      console.log('Item inserted', item);
    } catch (e) {
      console.error(e);
      return undefined;
    }
  }

  /**
   * getItem
   * @param {*} item
   * @returns
   * @description gets an item from the database by ID (CID)
   */
  async getItem(item) {
    console.log('trying to retrieve with ID', item.id);
    try {
      const resp = await this.db.find({ id: item.id });
      // console.log('resp is ', resp);
      if (resp) {
        return resp;
      } else {
        return null;
      }
    } catch (e) {
      console.error(e);
      return null;
    }
  }

  /**
   * getList
   * @param {*} options
   * @returns
   * @description gets a list of items from the database by ID (CID)
   * or by round
   */
  async getList(options) {
    // doesn't support options or rounds yet?
    let itemListRaw;
    if (!options) {
      itemListRaw = await this.db.find({ item: { $exists: true } });
    } else {
      if (options.round) {
        console.log('has round', options.round);
        // itemListRaw = await this.db.find({ item: { $exists: true } });
        itemListRaw = await this.db.find({ round: options.round });
      }
    }
    // let itemList = itemListRaw.map(itemList => itemList.item);
    return itemListRaw;
  }

  /**
   * createSearchTerm
   * @description creates a search term for the database
   */
  async createSearchTerm(searchTerms, round) {
    try {
      const objToInsert = {
        termRound: round,
        terms: searchTerms,
      };
      await this.db.insert(objToInsert);
      console.log('Search terms inserted for round', round);
    } catch (e) {
      console.error(e);
      return undefined;
    }
  }

  /**
   * getSearchTerm
   * @description gets a search term from the database
   */
  async getSearchTerm(round) {
    try {
      console.log('trying to retrieve search term for round', round);
      const resp = await this.db.find({"termRound": parseInt(round)});
      console.log('resp is ', resp)
      // Check if resp has content and return accordingly
      if (resp && resp.length > 0) {
        return resp[0].terms; // Assuming you want the 'terms' array from the first matching record
      }

      return null; // Return null if no results or empty results
    } catch (e) {
      console.error('Error retrieving searchTerm for round:', round, e);
      return null;
    }
  }
}

module.exports = Data;
