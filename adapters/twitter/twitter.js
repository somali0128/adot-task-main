// Import required modules
const Adapter = require('../../model/adapter');
const cheerio = require('cheerio');
// const { SpheronClient, ProtocolEnum } = require('@spheron/storage');
const {KoiiStorageClient} = require('@_koii/storage-task-sdk');
const axios = require('axios');
const Data = require('../../model/data');
const PCR = require('puppeteer-chromium-resolver');
const { namespaceWrapper } = require('../../namespaceWrapper');
const fs = require('fs');

/**
 * Twitter
 * @class
 * @extends Adapter
 * @description
 * Provides a crawler interface for the data gatherer nodes to use to interact with twitter
 */

class Twitter extends Adapter {
  constructor(credentials, db, maxRetry) {
    super(credentials, maxRetry);
    this.credentials = credentials;
    this.db = new Data('db', []);
    this.db.initializeData();
    this.proofs = new Data('proofs', []);
    this.proofs.initializeData();
    this.cids = new Data('cids', []);
    this.cids.initializeData();
    this.toCrawl = [];
    this.searchTerm = [];
    this.parsed = {};
    this.lastSessionCheck = null;
    this.sessionValid = false;
    this.browser = null;
    this.w3sKey = null;
    this.round = null;
  }

  /**
   * checkSession
   * @returns {Promise<boolean>}
   * @description
   * 1. Check if the session is still valid
   * 2. If the session is still valid, return true
   * 3. If the session is not valid, check if the last session check was more than 1 minute ago
   * 4. If the last session check was more than 1 minute ago, negotiate a new session
   */
  checkSession = async () => {
    if (this.sessionValid) {
      return true;
    } else if (Date.now() - this.lastSessionCheck > 50000) {
      await this.negotiateSession();
      return true;
    } else {
      return false;
    }
  };

  /**
   * negotiateSession
   * @returns {Promise<void>}
   * @description
   * 1. Get the path to the Chromium executable
   * 2. Launch a new browser instance
   * 3. Open a new page
   * 4. Set the viewport size
   * 5. Queue twitterLogin()
   */
  negotiateSession = async () => {
    try {
      if (this.browser) {
        await this.browser.close();
        console.log('Old browser closed');
      }
      const options = {};
      const stats = await PCR(options);
      console.log(
        '*****************************************CALLED PURCHROMIUM RESOLVER*****************************************',
      );
      this.browser = await stats.puppeteer.launch({
        // headless: false,
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
        executablePath: stats.executablePath,
      });
      console.log('Step: Open new page');
      this.page = await this.browser.newPage();
      await this.page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      );
      await this.page.setViewport({ width: 1920, height: 1080 });
      await this.twitterLogin();
      return true;
    } catch (e) {
      console.log('Error negotiating session', e);
      return false;
    }
  };

  /**
   * twitterLogin
   * @returns {Promise<void>}
   * @description
   * 1. Go to twitter.com
   * 2. Go to login page
   * 3. Fill in username
   * 4. Fill in password
   * 5. Click login
   * 6. Wait for login to complete
   * 7. Check if login was successful
   * 8. If login was successful, return true
   * 9. If login was unsuccessful, return false
   * 10. If login was unsuccessful, try again
   */
  twitterLogin = async () => {
    try {
      const cookieLoginSuccess = await this.tryLoginWithCookies();
      if (cookieLoginSuccess) {
        this.sessionValid = true;
        return this.sessionValid;
      } else {
        console.log('Step: Go to login page');
        await this.page.goto('https://twitter.com/i/flow/login', {
          timeout: 60000,
        });

        console.log('Step: Fill in username');
        console.log(this.credentials.username);

        await this.page.waitForSelector('input[autocomplete="username"]', {
          timeout: 60000,
        });
        await this.page.type(
          'input[autocomplete="username"]',
          this.credentials.username,
        );
        await this.page.keyboard.press('Enter');

        const twitter_verify = await this.page
          .waitForSelector('input[data-testid="ocfEnterTextTextInput"]', {
            timeout: 5000,
            visible: true,
          })
          .then(() => true)
          .catch(() => false);

        if (twitter_verify) {
          await this.page.type(
            'input[data-testid="ocfEnterTextTextInput"]',
            this.credentials.username,
          );
          await this.page.keyboard.press('Enter');
        }

        console.log('Step: Fill in password');
        const currentURL = await this.page.url();
        await this.page.waitForSelector('input[name="password"]');
        await this.page.type(
          'input[name="password"]',
          this.credentials.password,
        );
        console.log('Step: Click login button');
        await this.page.keyboard.press('Enter');

        // TODO - catch unsuccessful login and retry up to query.maxRetry
        if (!(await this.isPasswordCorrect(this.page, currentURL))) {
          console.log('Password is incorrect or email verfication needed.');
          await this.page.waitForTimeout(5000);
          this.sessionValid = false;
        } else if (await this.isEmailVerificationRequired(this.page)) {
          console.log('Email verification required.');
          this.sessionValid = false;
          await this.page.waitForTimeout(1000000);
        } else {
          console.log('Password is correct.');
          this.page.waitForNavigation({ waitUntil: 'load' });
          await this.page.waitForTimeout(5000);

          this.sessionValid = true;
          this.lastSessionCheck = Date.now();

          console.log('Step: Login successful');
          // Extract cookies
          const cookies = await this.page.cookies();
          // console.log('cookies', cookies);
          // Save cookies to database
          await this.saveCookiesToDB(cookies);
        }

        return this.sessionValid;
      }
    } catch (e) {
      console.log('Error logging in', e);
      this.sessionValid = false;
      return false;
    }
  };

  tryLoginWithCookies = async () => {
    const cookies = await this.db.getCookie();
    // console.log('cookies', cookies);
    if (cookies !== null) {
      await this.page.setCookie(...cookies);

      await this.page.goto('https://twitter.com/home');

      await this.page.waitForTimeout(5000);

      // Replace the selector with a Twitter-specific element that indicates a logged-in state
      // This is just an example; you'll need to determine the correct selector for your case
      const isLoggedIn =
        (await this.page.url()) !==
        'https://twitter.com/i/flow/login?redirect_after_login=%2Fhome';

      if (isLoggedIn) {
        console.log('Logged in using existing cookies');
        console.log('Updating last session check');
        const cookies = await this.page.cookies();
        this.saveCookiesToDB(cookies);
        this.sessionValid = true;
        // Optionally, refresh or validate cookies here
      } else {
        console.log('No valid cookies found, proceeding with manual login');
        this.sessionValid = false;
      }
      return this.sessionValid;
    } else {
      console.log('No cookies found');
      return false;
    }
  };

  saveCookiesToDB = async cookies => {
    try {
      const data = await this.db.getCookie();
      // console.log('data', data);
      if (data) {
        await this.db.updateCookie({ id: 'cookies', data: cookies });
      } else {
        await this.db.createCookie({ id: 'cookies', data: cookies });
      }
    } catch (e) {
      console.log('Error saving cookies to database', e);
    }
  };

  isPasswordCorrect = async (page, currentURL) => {
    await this.page.waitForTimeout(5000);

    const newURL = await this.page.url();
    if (newURL === currentURL) {
      return false;
    }
    return true;
  };

  isEmailVerificationRequired = async page => {
    // Wait for some time to allow the page to load the required elements
    await page.waitForTimeout(5000);

    // Check if the specific text is present on the page
    const textContent = await this.page.evaluate(
      () => document.body.textContent,
    );
    return textContent.includes(
      'Verify your identity by entering the email address associated with your X account.',
    );
  };

  /**
   * getSubmissionCID
   * @param {string} round - the round to get the submission cid for
   * @returns {string} - the cid of the submission
   * @description - this function should return the cid of the submission for the given round
   * if the submission has not been uploaded yet, it should upload it and return the cid
   */
  getSubmissionCID = async round => {
    if (this.proofs) {
      // we need to upload proofs for that round and then store the cid
      const data = await this.cids.getList({ round: round });
      console.log(`got cids list for round ${round}`);

      if (data && data.length === 0) {
        console.log('No cids found for round ' + round);
        return null;
      } else {
        let proof_cid;
        let path = `dataList.json`;
        let basePath = '';
        try {
          basePath = await namespaceWrapper.getBasePath();
          fs.writeFileSync(`${basePath}/${path}`, JSON.stringify(data));
        } catch (err) {
          console.log(err);
        }
        const client = new KoiiStorageClient(undefined, undefined, true);
        const userStaking = await namespaceWrapper.getSubmitterAccount();
        console.log(`Uploading ${basePath}/${path}`);
        const fileUploadResponse = await client.uploadFile(`${basePath}/${path}`,userStaking);
        console.log(`Uploaded ${basePath}/${path}`);
        let cid;
        try{
          cid = fileUploadResponse.cid;
        }catch(e){
          cid = null;
          console.log("Upload to our cid failed");
        }
        proof_cid = cid;
        await this.proofs.create({
          id: 'proof:' + round,
          proof_round: round,
          proof_cid: proof_cid,
        });

        if (cid !== 'default') {
          console.log('returning proof cid for submission', cid);
          return cid;
        }
      }
    } else {
      throw new Error('No proofs database provided');
    }
  };

  /**
   * parseItem
   * @param {string} url - the url of the item to parse
   * @param {object} query - the query object to use for parsing
   * @returns {object} - the parsed item
   * @description - this function should parse the item at the given url and return the parsed item data
   *               according to the query object and for use in either crawl() or validate()
   */
  parseItem = async item => {
    if (this.sessionValid == false) {
      await this.negotiateSession();
    }
    try {
      const $ = cheerio.load(item);
      let data = {};

      const articles = $('article[data-testid="tweet"]').toArray();
      const el = articles[0];
      const tweetUrl = $('a[href*="/status/"]').attr('href');
      const tweetId = tweetUrl.split('/').pop();
      const screen_name = $(el).find('a[tabindex="-1"]').text();
      const allText = $(el).find('a[role="link"]').text();
      const user_name = allText.split('@')[0];
      // console.log('user_name', user_name);
      const user_url =
        'https://twitter.com' + $(el).find('a[role="link"]').attr('href');
      const user_img = $(el).find('img[draggable="true"]').attr('src');

      const tweet_text = $(el)
        .find('div[data-testid="tweetText"]')
        .first()
        .text();

      const outerMediaElements = $(el).find('div[data-testid="tweetText"] a');

      const outer_media_urls = [];
      const outer_media_short_urls = [];

      outerMediaElements.each(function () {
        const fullURL = $(this).attr('href');
        const shortURL = $(this).text().replace(/\s/g, '');

        // Ignore URLs containing "/search?q=" or "twitter.com"
        if (
          fullURL &&
          !fullURL.includes('/search?q=') &&
          !fullURL.includes('twitter.com') &&
          !fullURL.includes('/hashtag/')
        ) {
          outer_media_urls.push(fullURL);
          outer_media_short_urls.push(shortURL);
        }
      });

      const timeRaw = $(el).find('time').attr('datetime');
      const time = await this.convertToTimestamp(timeRaw);
      const tweet_record = $(el).find(
        'span[data-testid="app-text-transition-container"]',
      );
      const commentCount = tweet_record.eq(0).text();
      const likeCount = tweet_record.eq(1).text();
      const shareCount = tweet_record.eq(2).text();
      const viewCount = tweet_record.eq(3).text();
      if (screen_name && tweet_text) {
        data = {
          user_name: user_name,
          screen_name: screen_name,
          user_url: user_url,
          user_img: user_img,
          tweets_id: tweetId,
          tweets_content: tweet_text.replace(/\n/g, '<br>'),
          time_post: time,
          time_read: Date.now(),
          comment: commentCount,
          like: likeCount,
          share: shareCount,
          view: viewCount,
          outer_media_url: outer_media_urls,
          outer_media_short_url: outer_media_short_urls,
          keyword: this.searchTerm,
        };
      }
      return data;
    } catch (e) {
      console.log(
        'Filtering advertisement tweets; continuing to the next item.',
      );
    }
  };

  convertToTimestamp = async dateString => {
    const date = new Date(dateString);
    return Math.floor(date.getTime() / 1000);
  };

  /**
   * crawl
   * @param {string} query
   * @returns {Promise<string[]>}
   * @description Crawls the queue of known links
   */
  crawl = async query => {
    console.log('valid? ', this.sessionValid);
    if (this.sessionValid == true) {
      this.searchTerm = query.searchTerm;
      this.round = query.round;
      await this.fetchList(query.query, query.round);
    } else {
      await this.negotiateSession();
    }
  };

  /**
   * fetchList
   * @param {string} url
   * @returns {Promise<string[]>}
   * @description Fetches a list of links from a given url
   */
  fetchList = async (url, round) => {
    try {
      console.log('fetching list for ', url);
      // Go to the hashtag page
      await this.page.waitForTimeout(5000);
      await this.page.setViewport({ width: 1024, height: 4000 });
      await this.page.goto(url);

      // Wait an additional 5 seconds until fully loaded before scraping
      await this.page.waitForTimeout(5000);

      while (true) {
        // Check if the error message is present on the page inside an article element
        const errorMessage = await this.page.evaluate(() => {
          const elements = document.querySelectorAll('div[dir="ltr"]');
          for (let element of elements) {
            console.log(element.textContent);
            if (
              element.textContent === 'Something went wrong. Try reloading.'
            ) {
              return true;
            }
          }
          return false;
        });

        // Scrape the tweets
        const items = await this.page.evaluate(() => {
          const elements = document.querySelectorAll(
            'article[aria-labelledby]',
          );
          return Array.from(elements).map(element => element.outerHTML);
        });

        for (const item of items) {
          await new Promise(resolve => setTimeout(resolve, 1000)); // Adds a 1-second delay
          try {
            let data = await this.parseItem(item);
            // console.log(data);
            if (data.tweets_id) {
              // Check if id exists in database
              let checkItem = {
                id: data.tweets_id,
              };
              const existingItem = await this.db.getItem(checkItem);
              if (!existingItem) {
                // Store the item in the database
                // const cid = await storeFiles(data, this.w3sKey);
                // const cid = 'testcid';
                console.log(`Storing data for ${data.tweets_id}`);
                this.cids.create({
                  id: data.tweets_id,
                  round: round,
                  data: data,
                });
              }
            }
          } catch (e) {
            console.log(
              'Filtering advertisement tweets; continuing to the next item.',
            );
          }
        }
        try {
          // console.log(
          //   'round check',
          //   this.round,
          //   await namespaceWrapper.getRound(),
          // );
          if (this.round !== (await namespaceWrapper.getRound())) {
            console.log('round changed, closed old browser');
            this.browser.close();
            break;
          }
          // Scroll the page for next batch of elements
          await this.scrollPage(this.page);

          // Optional: wait for a moment to allow new elements to load
          await this.page.waitForTimeout(5000);

          // Refetch the elements after scrolling
          await this.page.evaluate(() => {
            return document.querySelectorAll('article[aria-labelledby]');
          });
        } catch (e) {
          console.log('round check error', e);
        }
        // If the error message is found, wait for 2 minutes, refresh the page, and continue
        if (errorMessage) {
          console.log('Rate limit reach, waiting for next round...');
          this.browser.close();
          break;
        }
      }
      return;
    } catch (e) {
      console.log('Last round fetching list stop', e);
      this.browser.close();
      return;
    }
  };

  scrollPage = async page => {
    await page.evaluate(() => {
      window.scrollBy(0, window.innerHeight);
    });
    await page.waitForTimeout(5000); // Adjust the timeout as necessary
  };

  /**
   * processLinks
   * @param {string[]} links
   * @returns {Promise<void>}
   * @description Processes a list of links
   * @todo Implement this function
   * @todo Implement a way to queue links
   */
  processLinks = async links => {
    links.forEach(link => {});
  };

  /**
   * stop
   * @returns {Promise<boolean>}
   * @description Stops the crawler
   */
  stop = async () => {
    if (this.browser) {
      await this.browser.close();
      console.log('Old browser closed');
    }
    return (this.break = true);
  };
}

module.exports = Twitter;

// async function makeStorageClient() {
//   try {
//     let token = await getAccessToken();
//     return new SpheronClient({
//       token: token,
//     });
//   } catch (e) {
//     console.log('Error: Missing spheron token, trying again');
//   }
// }

// async function storeFiles(data, token) {
//   try {
//     let cid;
//     const client = new KoiiStorageClient.default();
//     let path = `data.json`;
//     let basePath = '';
//     try {
//       basePath = await namespaceWrapper.getBasePath();
//       fs.writeFileSync(`${basePath}/${path}`, JSON.stringify(data));
//     } catch (err) {
//       console.log(err);
//     }

//     try {
//       // console.log(`${basePath}/${path}`)
//       let spheronData = await client.uploadFile(`${basePath}/${path}`);
//       cid = spheronData.cid;
//     } catch (err) {
//       console.log('error uploading to IPFS, trying again', err);
//     }
//     return cid;
//   } catch (e) {
//     console.log('Error storing files, missing spheron token', e);
//   }
// }

// async function getAccessToken() {
//   return process.env.Spheron_Storage;
// }
