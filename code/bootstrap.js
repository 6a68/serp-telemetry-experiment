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

var serpCountQuery = 'SELECT COUNT(*) AS count FROM moz_historyvisits ' +
                     'INNER JOIN moz_places ' +
                     'ON moz_historyvisits.place_id = moz_places.id ' +
                     'WHERE moz_places.url LIKE ":providerURL" ;';
var counts = {
  google: null,
  yahoo: null,
  amazon: null,
  total: null
};

var getCount = function(url, db) {
  if (isExiting) { return Promise.reject(new Error('aborting because isExiting is true')); }
  var query = serpCountQuery.replace(':providerURL', url);
  return db.execute(query);
};
var getGoogleCount = getCount.bind(null, '%google.com/search?q%');
var getYahooCount = getCount.bind(null, '%/search.yahoo.com/yhs/search?p%');
var getBingCount = getCount.bind(null, '%bing.com/search?q%');
var getAmazonCount = getCount.bind(null, '%amazon.com/s?%');

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
  var query = 'SELECT COUNT(*) AS count FROM moz_historyvisits;';
  return db.execute(query);
};

// TODO
var send = function(data) {
  // JSONify the data
  // ship down via XHR POST (what endpoint?)
}

// on error, if we're not exiting, return the error message and the step
// number that failed.
var onError = function(step, err) {
  if (!isExiting) {
    try {
      send({status: failure, step: step, error: err});
    // if sending fails, there's nothing left to do but give up
    } catch(e) {}
  }
  uninstall();
}

var runExperiment = function() {
  return PlacesUtils.promiseDBConnection()
    // google bits
    .then(getGoogleCount, onError.bind(null, 'getGoogleCount'))
    .then(saveCount.bind(null, 'google'), onError.bind(null, 'saveCount::google'))
    // yahoo bits
    .then(PlacesUtils.promiseDBConnection, onError.bind(null, 'promiseDBConnection'))
    .then(getYahooCount, onError.bind(null, 'getYahooCount'))
    .then(saveCount.bind(null, 'yahoo'), onError.bind(null, 'saveCount::yahoo'))
    // bing bits
    .then(PlacesUtils.promiseDBConnection, onError.bind(null, 'promiseDBConnection'))
    .then(getBingCount, onError.bind(null, 'getBingCount'))
    .then(saveCount.bind(null, 'bing'), onError.bind(null, 'saveCount::bing'))
    // amzn bits
    .then(PlacesUtils.promiseDBConnection, onError.bind(null, 'promiseDBConnection'))
    .then(getAmazonCount, onError.bind(null, 'getAmazonCount'))
    .then(saveCount.bind(null, 'amazon'), onError.bind(null, 'saveCount::amazon'))
    // total
    .then(PlacesUtils.promiseDBConnection, onError.bind(null, 'promiseDBConnection'))
    .then(getTotalCount, onError.bind(null, 'getTotalCount'))
    .then(saveCount.bind(null, 'total'), onError.bind(null, 'saveCount::total'))
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
    // TODO: best way to report back on failure?
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

