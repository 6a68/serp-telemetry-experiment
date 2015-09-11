/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const {classes: Cc, interfaces: Ci, utils: Cu} = Components;
Cu.import("resource://gre/modules/XPCOMUtils.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "Experiments",
                                  "resource:///modules/experiments/Experiments.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "PlacesUtils",
                                  "resource://gre/modules/PlacesUtils.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "RecentWindow",
                                  "resource:///modules/RecentWindow.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "Services",
                                  "resource://gre/modules/Services.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "Task",
                                  "resource://gre/modules/Task.jsm");
/*
 * experiment code
 */

// if true, abort any remaining DB requests or beacons
let isExiting = false;

// see https://bugzil.la/1174937#c16 for explanation of query optimizations
const query = `SELECT SUM(visit_count) AS count, url FROM moz_places
               WHERE rev_host BETWEEN :reversed AND :reversed || X'FFFF'
               AND url LIKE :fuzzy`;

// we need a window pointer to get access to navigator.sendBeacon, but we have
// to wait until a DOMWindow is ready (see runExperiment below)
let window;

const countUrl = "https://statsd-bridge.services.mozilla.com/count/beta39.1174937.serpfraction.";
const gaugeUrl = "https://statsd-bridge.services.mozilla.com/gauge/beta39.1174937.serpfraction.";

const searchProviders = {
  google: {
    reversed: "moc.elgoog.",
    fuzzy: "%google.com/search?q%"
  },
  yahoo: {
    reversed: "moc.oohay.",
    fuzzy: "%search.yahoo.com/yhs/search?p%"
  },
  bing: {
    reversed: "moc.gnib.",
    fuzzy: "%bing.com/search?q%"
  }
};

const counts = {
  google: null,
  yahoo: null,
  bing: null,
  total: null
};

function saveCount(providerName, results) {
  // query returns undefined if there are no visits to the specified page; replace with 0
  let count = results && results[0] && results[0].getResultByName("count") || 0;
  counts[providerName] = count;
}

// returns an integer percentage or null if either operand was invalid.
// division operator handles type coercion for us
function percentage(a, b) {
  const result = a / b;
  return isFinite(result) ? Math.round(result * 100) : null;
}

function sendBeacon(url, data) {
  if (isExiting) {
    return;
  }
  try {
    window.navigator.sendBeacon(url, data);
  } catch (ex) {
    // something's wrong, give up
    uninstall();
  }
}

// For each search provider, either send the result percentage for that
// provider, or increment an error counter. Also send down the total history
// size for that user, and increment the total count of responding clients.
function send(data) {
  ["google", "yahoo", "bing"].forEach(function(provider) {
    let pct = percentage(counts[provider], counts.total);
    if (pct !== null) {
      sendBeacon(gaugeUrl + provider, pct);
    } else {
      sendBeacon(countUrl + provider + ".error", 1);
    }
  });
  sendBeacon(gaugeUrl + "total", counts.total);
  sendBeacon(countUrl + "clients", 1);
}

// If an error occurs when querying or connecting to the DB, just give up:
// fire a beacon with the name of the failed step (in dot-delimited statsd
// format) and uninstall the experiment.
function onError(step, err) {
  sendBeacon(countUrl + "error." + step, 1)
  uninstall();
}

// annoying, but unavoidable, window management code
// implements nsIWindowMediatorListener
// pulled from MDN: https://developer.mozilla.org/en-US/docs/Mozilla/Tech/XPCOM/Reference/Interface/nsIWindowMediator#addListener()
let windowListener = {
  onOpenWindow: function(aWindow) {
    Services.wm.removeListener(windowListener);
    let domWindow = aWindow.QueryInterface(Ci.nsIInterfaceRequestor).
                            getInterface(Ci.nsIDOMWindowInternal || Ci.nsIDOMWindow);
    function onDomWindowReady() {
      domWindow.removeEventListener("load", onDomWindowReady);
      // if this is not a browser window, bail
      let windowType = domWindow.document.documentElement.getAttribute("windowtype");
      if (windowType !== "navigator:browser") {
        return;
      }
      // assign the addon-global window variable, so that
      // "window.navigator.sendBeacon" will be defined
      window = domWindow;
      _runExperiment()
        .catch(onError)
        .then(() => {
          uninstall();
        });
    }
    domWindow.addEventListener("load", onDomWindowReady);
  },
  onCloseWindow: function(aWindow) {},
  onWindowTitleChange: function(aWindow, aTitle) {}
};

function runExperiment() {
  if (isExiting) {
    return;
  }
  // get a window, or wait till a window is opened, then continue.
  let win = RecentWindow.getMostRecentBrowserWindow();
  if (win) {
    windowListener.onOpenWindow(win);
  } else {
    Services.wm.addListener(windowListener);
  }
}

let getTotalCount = Task.async(function* (db) {
  if (isExiting) {
    return;
  }
  return yield db.execute(`
    SELECT COUNT(*) AS count FROM moz_historyvisits;
  `);
});

let _runExperiment = Task.async(function* () {
  let db = yield PlacesUtils.promiseDBConnection();
  for (let providerName in searchProviders) {
    if (isExiting) {
      break;
    }
    let result = yield db.execute(query, searchProviders[providerName]);
    saveCount(providerName, result);
  }
  let totalResult = getTotalCount();
  saveCount("total", totalResult);
  send();
  uninstall();
});

function exit() {
  // abort any future Places queries or beacons
  isExiting = true;
}

/*
 *  bootstrapped addon code
 */

function startup() {
  try {
    runExperiment();
  } catch(ex) {
    onError("startup", ex);
  }
}
function shutdown() {
  exit();
}
function install() {
}
function uninstall() {
  exit();
  Experiments.disableExperiment("FROM_API");
}

