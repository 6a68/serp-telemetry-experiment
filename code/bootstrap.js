/*
 * This is a JavaScript Scratchpad.
 *
 * Enter some JavaScript, then Right Click or choose from the Execute Menu:
 * 1. Run to evaluate the selected text (Cmd-R),
 * 2. Inspect to bring up an Object Inspector on the result (Cmd-I), or,
 * 3. Display to insert the result in a comment after the selection. (Cmd-L)
 */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/// disabled for testing
/// "use strict";

/// disabled for testing
/// const {classes: Cc, interfaces: Ci, utils: Cu} = Components;
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
/// disabled for testing
/// let window;

const countUrl = "https://statsd-bridge.services.mozilla.com/count/beta42.1174937.serpfraction.";
const gaugeUrl = "https://statsd-bridge.services.mozilla.com/gauge/beta42.1174937.serpfraction.";

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
  console.log('Telex: saveCount');
  // query returns undefined if there are no visits to the specified page; replace with 0
  let count = results && results[0] && results[0].getResultByName("count") || 0;
  console.log('Telex.saveCount: the count for ' + providerName + ' is ' + count);
  counts[providerName] = count;
}

// returns an integer percentage or null if either operand was invalid.
// division operator handles type coercion for us
function percentage(a, b) {
  console.log('Telex: percentage');
  const result = a / b;
  return isFinite(result) ? Math.round(result * 100) : null;
}

function sendBeacon(url, data) {
  console.log('Telex: sendBeacon: url, ', url, 'data: ', data);
  if (isExiting) {
    return;
  }
  try {
    window.navigator.sendBeacon(url, data);
  } catch (ex) {
    // something's wrong, give up
    console.error('Telex: sendBeacon error: ', ex);
    uninstallExperiment();
  }
}

// For each search provider, either send the result percentage for that
// provider, or increment an error counter. Also send down the total history
// size for that user, and increment the total count of responding clients.
function send(data) {
  console.log('Telex: send: ', data);
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
// format) and uninstallExperiment the experiment.
function onError(step) {
  console.log('Telex: onError: ', step);
  sendBeacon(countUrl + "error." + step, 1)
  uninstallExperiment();
}

function onDomWindowReady(domWindow) {
  console.log('Telex: onDomWindowReady');
  try {
    domWindow.removeEventListener("load", onDomWindowReady);
    // if this is not a browser window, bail
    let windowType = domWindow.document.documentElement.getAttribute("windowtype");
    if (windowType !== "navigator:browser") {
      return;
    }
    // assign the addon-global window variable, so that
    // "window.navigator.sendBeacon" will be defined
    /// disabled for scratchpad testing 
    /// window = domWindow;
    _runExperiment()
      .catch(() => {
      onError("experiment");
    })
      .then(() => {
      uninstallExperiment();
    });
  } catch(ex) {
    console.error('Telex.onDomWindowReady failed: ', ex);
  }
}



// annoying, but unavoidable, window management code
// implements nsIWindowMediatorListener
// pulled from MDN: https://developer.mozilla.org/en-US/docs/Mozilla/Tech/XPCOM/Reference/Interface/nsIWindowMediator#addListener()
let windowListener = {
  onOpenWindow: function(aWindow) {
    console.log('Telex: onOpenWindow');
    try {
     Services.wm.removeListener(windowListener);
     let domWindow = aWindow.QueryInterface(Ci.nsIInterfaceRequestor).
                             getInterface(Ci.nsIDOMWindow);
      console.log('Telex.onOpenWindow: does domWindow exist?', domWindow);
      if (domWindow && domWindow.document && domWindow.document.readyState === 'complete') {
        console.log('window document is loaded, so lets just get to work');
        onDomWindowReady(domWindow);
      } else {
        domWindow.addEventListener("load", onDomWindowReady);
      }
    } catch (ex) {
      console.error('Telex.onOpenWindow failed: ', ex);
    }
  },
  onCloseWindow: function(aWindow) {},
  onWindowTitleChange: function(aWindow, aTitle) {}
};

function runExperiment() {
  console.log('Telex: runExperiment');
  try {
    if (isExiting) {
      console.log('Telex: runExperiment exiting because isExiting is true');
      return;
    }
    // get a window, or wait till a window is opened, then continue.
    let win = RecentWindow.getMostRecentBrowserWindow();
    console.log('Telex: did runExperiment find a window? ', !!win);
    if (win) {
      windowListener.onOpenWindow(win);
    } else {
      Services.wm.addListener(windowListener);
    }
  } catch(ex) {
    console.error('Telex.runExperiment failed: ', ex);
  }
}

let getTotalCount = Task.async(function* (db) {
  console.log('Telex: getTotalCount');
  if (isExiting) {
    return;
  }
  return yield db.execute(`
    SELECT COUNT(*) AS count FROM moz_historyvisits;
  `);
});

let _runExperiment = Task.async(function* () {
  console.log('Telex: _runExperiment');
  let db = yield PlacesUtils.promiseDBConnection();
  console.log('Telex._runExperiment: is db defined?', db);
  for (let providerName in searchProviders) {
    console.log('Telex._runExperiment: now running query for search provider ' + providerName);
    if (isExiting) {
      console.log('Telex._runExperiment: isExiting true, not running query for ' + providerName);
      break;
    }
    try {
      let result = yield db.execute(query, searchProviders[providerName]);
      console.log('Telex._runExperiment: results of query are ', result);
      saveCount(providerName, result);
    } catch (ex) {
      console.error('db.execute or saveCount failed: ', ex);
    }
  }
  console.log('Telex._runExperiment: done iterating search providers, now getting total');
  let totalResult = getTotalCount(db);
  console.log('Telex._runExperiment: totalResult is ', totalResult);
  saveCount("total", totalResult);
  send(counts);
  uninstallExperiment();
});

function exit() {
  console.log('Telex: exit');
  // abort any future Places queries or beacons
  isExiting = true;
}

/*
 *  bootstrapped addon code
 */

// the startup method is apparently called twice, so you have to guard against
// that manually via gStarted. See
//   https://bugzilla.mozilla.org/show_bug.cgi?id=1174937#c44
// and see also, for example,
//   http://hg.mozilla.org/webtools/telemetry-experiment-server/file/ (cont'd)
//   59365ce5cabe/experiments/flash-protectedmode-beta/code/bootstrap.js#l12
var gStarted = false;

function startup() {
  console.log('Telex: startup');
  if (gStarted) {
    return;
  }
  gStarted = true;

  try {
    runExperiment();
  } catch(ex) {
    console.error('Telex: runExperiment failed with error: ', ex);
    onError("startup");
  }
}

function shutdown() {
  console.log('Telex: shutdown');
  exit();
}

function uninstallExperiment() {
  console.log('Telex: uninstallExperiment');
  exit();
  Experiments.instance().disableExperiment("FROM_API");
}

function install() {
  console.log('Telex: install');
}

function uninstall() {
  console.log('Telex: uninstall');
}

console.log('starting the experiment');
startup();


