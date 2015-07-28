/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

'use strict';

const {classes: Cc, interfaces: Ci, utils: Cu} = Components;
Cu.import("resource://gre/modules/XPCOMUtils.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "PlacesUtils",
                                  "resource://gre/modules/PlacesUtils.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "Promise",
                                  "resource://gre/modules/Promise.jsm");

/*
 * experiment code
 */

// XHR pointer. we'll abort this if we get uninstalled mid-flight.
var request;

// global boolean; we don't have a pointer to the DB connection to abort requests,
// but we can check the value of isExiting between issuing requests, and bail if
// needed
var isExiting = false;

// see https://bugzil.la/1174937#c16 for explanation of query optimizations
var query = "SELECT SUM(visit_count) AS count, url FROM moz_places " +
                     "WHERE rev_host BETWEEN :reversed AND :reversed || X'FFFF' " +
                     "AND url LIKE :fuzzy";

const countUrl = 'https://statsd-bridge.services.mozilla.com/count/test01.1174937.serpfraction.';
const gaugeUrl = 'https://statsd-bridge.services.mozilla.com/gauge/test01.1174937.serpfraction.';

var searchProviders = {
  google: {
    reversed: 'moc.elgoog.',
    fuzzy: '%google.com/search?q%'
  },
  yahoo: {
    reversed: 'moc.oohay.',
    fuzzy: '%search.yahoo.com/yhs/search?p%'
  },
  bing: {
    reversed: 'moc.gnib.',
    fuzzy: '%bing.com/search?q%'
  },
  amazon: {
    reversed: 'moc.nozama.',
    fuzzy: '%amazon.com/s?%'
  }
};

var counts = {
  google: null,
  yahoo: null,
  bing: null,
  amazon: null,
  total: null
};

var saveCount = function(providerName, results) {
  var count = results && results[0] && results[0].getResultByName('count');
  if (Number.isInteger(count)) {
    counts[providerName] = count;
    return Promise.resolve(count);
  } else {
    return Promise.reject(new Error('count for ' + providerName + ' was not an integer: ' + count));
  }
};

var totalCount = function(db) {
  if (isExiting) { return Promise.reject(new Error('aborting because isExiting is true')); }
  var totalQuery = 'SELECT COUNT(*) AS count FROM moz_historyvisits;';
  return db.execute(totalQuery);
};

// returns a percentage as an integer, or null if either operand was invalid
// division operator handles type coercion for us
var percentage = function(a, b) {
  var result = a/b;
  return isFinite(result) ? Math.round(result * 100) : null;
};

// For each search provider, either send the result percentage for that provider,
// or increment an error counter.
// Also send down the total history size for that user.
var send = function(data) {
  ['google', 'yahoo', 'bing', 'amazon'].forEach(function(provider) {
    let pct = percentage(counts[provider], counts.total);
    if (pct !== null) {
      navigator.sendBeacon(gaugeUrl + provider, pct);
      console.log(gaugeUrl + provider, pct);
    } else {
      navigator.sendBeacon(countUrl + provider + '.error', 1);
      console.log(countUrl + provider + '.error', 1);
    }
  });
  navigator.sendBeacon(gaugeUrl + 'total', counts.total);
  console.log(gaugeUrl + 'total', counts.total);
}

// If an error occurs when querying or connecting to the DB, just give up:
// fire a beacon with the name of the failed step (in dot-delimited statsd
// format) and uninstall the experiment.
var onError = function(step, err) {
  console.log(countUrl + 'error.' + step, 1)
  navigator.sendBeacon(countUrl + 'error.' + step, 1)
  uninstall();
}

var runExperiment = function() {
  return PlacesUtils.promiseDBConnection()
    // google bits
    .then(function(db) {
      return db.execute(query, searchProviders['google']);
    }, onError.bind(null, 'getGoogleCount'))
    .then(saveCount.bind(null, 'google'), onError.bind(null, 'saveCount.google'))
    // yahoo bits
    .then(PlacesUtils.promiseDBConnection, onError.bind(null, 'promiseDBConnection.yahoo'))
    .then(function(db) {
      return db.execute(query, searchProviders['yahoo']);
    }, onError.bind(null, 'getYahooCount'))
    .then(saveCount.bind(null, 'yahoo'), onError.bind(null, 'saveCount.yahoo'))
    // bing bits
    .then(PlacesUtils.promiseDBConnection, onError.bind(null, 'promiseDBConnection.bing'))
    .then(function(db) {
      return db.execute(query, searchProviders['yahoo']);
    }, onError.bind(null, 'getBingCount'))
    .then(saveCount.bind(null, 'bing'), onError.bind(null, 'saveCount.bing'))
    // amzn bits
    .then(PlacesUtils.promiseDBConnection, onError.bind(null, 'promiseDBConnection.amazon'))
    .then(function(db) {
      return db.execute(query, searchProviders['amazon']);
    }, onError.bind(null, 'getAmazonCount'))
    .then(saveCount.bind(null, 'amazon'), onError.bind(null, 'saveCount.amazon'))
    // total
    .then(PlacesUtils.promiseDBConnection, onError.bind(null, 'promiseDBConnection.total'))
    .then(getTotalCount, onError.bind(null, 'getTotalCount'))
    .then(saveCount.bind(null, 'total'), onError.bind(null, 'saveCount.total'))
    // xhr
    .then(send, onError.bind(null, 'send'))
    // when finished, uninstall yourself
    .then(uninstall, onError.bind(null, 'uninstall'));
};

var exit = function() {
  // abort any in-flight XHR
  request && request.abort();
  // abort any future Places queries
  isExiting = true;
};

/*
 *  bootstrapped addon code
 */

function startup() {
  try {
    runExperiment();
  } catch(ex) {
    onError('startup', ex);
  }
}
function shutdown() {
  exit();
}
function install() {
}
function uninstall() {
  exit();
}

