/*
** asyncTabCollector.js -- singleton object owned by selectTabDialog.js that gets tabs via frameScript messages
*/

const NEXT_TIMEOUT = 1;
const MAX_NUM_TAB_TRIES = 100;
const TAB_LOADING_WAIT_MS = 50;
const NEXT_TAB_QUERY_DELAY = 100;
const NEXT_TAB_QUERY_HANDOFF = 10; // Before doing the next tab handoff control.

const GET_TABS_ITERATE_DELAY = 0; // msec

try {

var tabCollector = {};
var globalMessageManager;
(function() {
   const Debug = false;
   const ShowMetrics = false;
   const VisitWindowsIteratively = true;

   var isConnecting = function(s) {
     // Probably a way to look at the tab and figure out if it's connected
     if (!s || s.indexOf("Connecting") != 0) return false;
     return s.match(/Connecting\s*(?:…|\.\.\.)/) || s == "New Tab";
   };

   this.dump = function(aMessage) {
       var consoleService = Components.classes["@mozilla.org/consoleservice;1"]
       .getService(Components.interfaces.nsIConsoleService);
       consoleService.logStringMessage("TH/ATC: " + aMessage);
   };

   this.init = function(_globalMessageManager) {
     this.wmService = (Components.classes["@mozilla.org/appshell/window-mediator;1"].
		       getService(Components.interfaces.nsIWindowMediator));
     if (typeof(globalMessageManager) == "undefined") {
       globalMessageManager = _globalMessageManager;
     }
     globalMessageManager.addMessageListener("tabhunter@ericpromislow.com:docType-has-image-continuation", this.process_docType_has_image_continuation_msg_bound);
     globalMessageManager.addMessageListener("tabhunter@ericpromislow.com:DOMTitleChanged", this.process_DOMTitleChanged_bound);
     this.lastGoodTabGetters = [];
     this.singleQueryTimes = [];
     this.singleQueryTimesCollector = {}; // timestamp:windowIdx:tabIdx: startTime
   };

   this.process_DOMTitleChanged = function() {
     if (Debug) {
       this.dump("**************** sessionTrack -- got a DOMTitleChanged msg from a frame script!");
     }
	gTabhunter.updateOnTabChange();
   };
   this.process_DOMTitleChanged_bound = this.process_DOMTitleChanged.bind(this);
   
   this.onUnload = function() {
     // Called from selectTabDialog.js:onUnload - do this when the tabhunter window is closed.
     globalMessageManager.removeMessageListener("tabhunter@ericpromislow.com:docType-has-image-continuation", this.process_docType_has_image_continuation_msg_bound);
     globalMessageManager.removeMessageListener("tabhunter@ericpromislow.com:DOMTitleChanged", this.process_DOMTitleChanged_bound);
     this.wmService = (Components.classes["@mozilla.org/appshell/window-mediator;1"].
		       getService(Components.interfaces.nsIWindowMediator));
     var openWindows = this.wmService.getEnumerator("navigator:browser");
     do {
	// There must be at least one window for an extension to run in
	var openWindow = openWindows.getNext();
	try {
	   Array.slice(openWindow.getBrowser().tabContainer.childNodes).forEach(function(tab) {
		try {
		   tab.linkedBrowser.messageManager.sendAsyncMessage("tabhunter@ericpromislow.com:docType-has-image-shutdown", {});
		   tab.linkedBrowser.messageManager.sendAsyncMessage("tabhunter@ericpromislow.com:content-focus-shutdown", {});
		   tab.linkedBrowser.messageManager.sendAsyncMessage("tabhunter@ericpromislow.com:search-next-tab-shutdown", {});
		} catch(ex2) {
		   self.dump("Failed to shutdown docType FS: " + ex2);
		}
	     });
	} catch(ex3) {
	   self.dump("Failed to shutdown docType FS: " + ex3);
	}
     } while (openWindows.hasMoreElements());
   };


     // OUT ARGS: tabs: unordered array of [TabInfo]
     //           windowInfo: array of [window: ChromeWindow, tabs: array of [DOM tabs]]   
     this.collectTabs = function(callback) {
       try {
	  this.getTabs_dualProcess(callback);
       } catch(ex) {
	 this.dump('asyncTabCollector.js - collectTabs - ' + ex + "\n" + ex.stack);
       }
     };

     this.dualProcessContinuationFinish = function() {
       if (this.tabGetters.every(function(tabGetter) tabGetter.finishedGettingTabs)) {
	 if (Debug) {
	   this.dump("**** all tabs are done at " + this.timestamp + ", loop over " +
		     this.tabGetters.length + " tabGetters");
	 }
	 if (ShowMetrics && this.singleQueryTimes.length > 0) {
	   this.ShowMetricsProcessTabsEndTime = new Date().valueOf();
	   this.dump("Non-loop Time to process all queries: " + (this.ShowMetricsProcessTabsEndTime - this.ShowMetricsProcessTabsStartTime) + " msec");
	   let sum = this.singleQueryTimes.reduce(function(pv, cv) pv + cv, 0);
	   this.dump("Avg time for " + this.singleQueryTimes.length + " (total tabs:" + this.numTabs + "): " + ((sum * 1.0) / this.singleQueryTimes.length) + " msec");
	   this.singleQueryTimes.splice(0);
	 }
	 this.clearTimeouts();
	 this.dualProcessSetupFinalCallback({completedQuery:true,
		                             numTabs:this.numTabs.length});
	 return true;
       }
       if (this.tabsToQuery.length > 0) {
	 this.nextTabToQueryTimeout = setTimeout(this.processTabsToQuery.bind(this), NEXT_TAB_QUERY_HANDOFF);
       }
       return false;
     };

     this.dualProcessSetupFinalCallback = function(options) {
       // pour everything into the return obj and
       // pass it on using the callback
       if (typeof(options) == "undefined") {
	 this.dump("**** Hey!!! dualProcessSetupFinalCallback: options not set")
	 options = {completedQuery:true};
       }
       let result = { tabs:[], windowInfo:[] }
       this.tabGetters.forEach(function(tabGetter) {
	    try {
	       result.tabs = result.tabs.concat(tabGetter.collector.tabs);
	       result.windowInfo.push(tabGetter.collector.currWindowInfo);
	    } catch(e2) {
	       this.dump("**** this.tabGetters.forEach: bad: " + e2);
	    }
	 }.bind(this));
       if (Debug) {
	  this.dump("QQQ: result:tabs: " + result.tabs.length
		    + ", windowInfo: " + result.windowInfo.length);
	  result.tabs.forEach(function(tab) {
	       this.dump("QQQ: window/tab " + tab.windowIdx + "-" + tab.tabIdx + "/" + tab.label + " - " + tab.location);
	    }.bind(this));
       }
       if (options.completedQuery) {
	 this.lastGoodTabGetters = this.tabGetters;
       }
       this.tabGetterCallback(result, options);
     };

     this.clearNextTabQuery = function() {
	 if (this.nextTabToQueryTimeout) {
	   clearTimeout(this.nextTabToQueryTimeout);
	   this.nextTabToQueryTimeout = 0;
	 }
     };
     this.clearCallbackTimeout = function() {
	 if (this.callbackTimeoutId) {
	    clearTimeout(this.callbackTimeoutId);
	    this.callbackTimeoutId = 0;
	 }
     };

     this.clearTimeouts = function() {
	 this.clearCallbackTimeout();
	 this.clearNextTabQuery();
     };

     this.getTabs_dualProcessContinuation = function(msg) {
       let result = this.getTabs_dualProcessContinuation_aux(msg);
       if (result) {
	  this.dualProcessContinuationFinish();
       }
     };
     
     this.getTabs_dualProcessContinuation_aux = function(msg) {
       try {
	 var data = msg.data;
	 var tabIdx = data.tabIdx;
	 var windowIdx = data.windowIdx;
	 var windowTabKey = windowIdx + "-" + tabIdx;

	 if (data.timestamp < this.timestamp) {
	    if (Debug) {
	       this.dump("got a message from an older request " + ((this.timestamp - data.timestamp)) + " msec ago");
	    }
	    return true;
	 }
	 if (this.processedTabs[windowTabKey]) {
	   if (Debug) {
	   this.dump("QQQ: we've already processed windowTabKey " + windowTabKey);
	   }
	   return true;
	 }

	 if (ShowMetrics && !data.shortCircuitUpdate) {
	   let key = data.timestamp + ":" + windowIdx + ":" + tabIdx;
	   if (key in this.singleQueryTimesCollector) {
	      let endTime = new Date().valueOf();
	      let et = endTime - this.singleQueryTimesCollector[key];
	      this.singleQueryTimes.push(et);
	      delete this.singleQueryTimesCollector[key];
	      this.dump("QQQ: Time to process query " + windowIdx + ":" + tabIdx + ": " + et + " msec");
	   } else {
	     //this.dump("QQQ: No singleQueryTimesCollector for key: " + windowIdx + ":" + tabIdx);
	   }
       }                  
	 var tabGetter = this.tabGetters[windowIdx];
	 if (!tabGetter) {
	    this.dump("Internal Error: Can't get a tabGetter for window " + windowIdx + " (tabIdx " + tabIdx + "), current length: " + this.tabGetters.length);
	    return false;
	 }
	 
	 var hasImage = data.hasImage;
	 var location = data.location;
	 if (Debug) {
	    this.dump("QQQ: getTabs_dualProcessContinuation: " +
		      "windowIdx: " + windowIdx +
		      ", tabIdx: " + tabIdx +
		      ", hasImage: " + hasImage +
		      ", location: " + location +
		      ", this.tabsToQuery.length: " + this.tabsToQuery.length);
		      
	 }
	 var tab = tabGetter.tabs[tabIdx];
	 var label = tab.label;

	 this.processedTabs[windowTabKey] = true;
	 tabGetter.collector.currWindowInfo.tabs.push(tab);
	 var image = tab.getAttribute('image') || '';
	 tabGetter.collector.tabs.push(new ep_extensions.tabhunter.TabInfo(windowIdx, tabIdx, label, image, location));
	 tabGetter.gotTabArray[tabIdx] = true;
	 if (tabGetter.gotTabArray.every(function(x) x)) {
	   if (Debug) {
	    this.dump("QQQ: Finished getting tabs for window " + windowIdx);
	   }
	    tabGetter.finishedGettingTabs = true;
	 } else {
	   if (Debug) {
	    this.dump("QQQ: Still more tabs for window " + windowIdx);
	   }
	 }
         return true;
       } catch(e) {
	 if (data.shortCircuitUpdate) {
	   throw(e);
	 }
	 this.dump("**** dualProcessContinuation: bad happened: " + e + "\n" + e.stack);
	 return true;
       }
     };

     this.process_docType_has_image_continuation_msg = function(msg) {
       if (Debug) {
	 tabCollector.dump("**** >>> Handling a docType-has-image-continuation notific'n");
	 //tabCollector.dump("**** tabCollector.tabGetters: " + (tabCollector.tabGetters.length + " tabGetters"));
       }
       tabCollector.getTabs_dualProcessContinuation.call(tabCollector, msg);
     };
     this.process_docType_has_image_continuation_msg_bound = this.process_docType_has_image_continuation_msg.bind(this)
         
     this.TabGetter = function(windowIdx, openWindow, tabs) {
       this.windowIdx = windowIdx;
       this.tabs = tabs;
       this.finishedGettingTabs = false;
       this.connectAttempt = 0; // to allow for doc loading
       this.collector = { tabs: [],
			  currWindowInfo: {window: openWindow, tabs: []}};
       this.gotTabArray = new Array(tabs.length);
       for (let i = 0; i < tabs.length; i++) this.gotTabArray[i] = false;
     };
     this.TabGetter.prototype.setImageSetting = function(tabIdx, timestamp) {
       var tab = this.tabs[tabIdx];
       if (Debug) {
	 this.dump("**** go do docType-has-image for windowIdx " +
		   this.windowIdx + ", tabIdx: " + tabIdx + " <" + tab.label + ">");
       }
       tab.linkedBrowser.messageManager.sendAsyncMessage("tabhunter@ericpromislow.com:docType-has-image", { tabIdx: tabIdx, windowIdx: this.windowIdx, timestamp:timestamp });
     };

     this.TabGetter.prototype.dump = function(aMessage) {
       var consoleService = Components.classes["@mozilla.org/consoleservice;1"]
       .getService(Components.interfaces.nsIConsoleService);
       consoleService.logStringMessage("TH/ATC/TabGetter: " + aMessage);
     };

     this.getTabs_dualProcess = function(callback) {
       // Get all the windows with tabs synchronously. Then get the
       // image info for each tab asynchronously, knit everything
       // together, and send the result back via the callback.
       this.clearTimeouts();
       var openWindows = this.wmService.getEnumerator("navigator:browser");
       
       this.tabGetterCallback = callback;
       this.processedTabs = {}; // hash "windowIdx-tabIdx : true"
       this.timestamp = new Date().valueOf();

       this.tabsToQuery = []; // Array of {windowIdx, tabIdx, openWindow}
       if (ShowMetrics) {
	  this.ShowMetricsStartTime = new Date().valueOf();
       }
       if (VisitWindowsIteratively) {
	  this.visitAllTabs(openWindows);
	  return;
       }
       // Get the eligible windows
       let nextWindow = openWindows.getNext();
       let tc = nextWindow.getBrowser().tabContainer.childNodes;
       this.numTabs = tc.length;
       if (Debug) {
       this.dump("QQQ: Window #1 has # tabs: " + tc.length);
       }
       
       // tabGetters: array of { tabs:[]"real" tabs, collector: {tabs:[]TabInfo, currWindowInfo: {window:openWindow, tabs:"real" []}  Really Eric -- 3 fields called "tabs"??
       this.tabGetters = [new this.TabGetter(0, nextWindow, tc)];
       this.madeRequest = false;
       this.getNextTabFuncBound(this.timestamp, openWindows, nextWindow, tc, 0, 0);
     };

     this.haveTabInfo = function(windowIdx, tabIdx, tc) {
       let lastGoodTabGetter = this.lastGoodTabGetters[windowIdx];
       if (!lastGoodTabGetter) {
	  return false;
       }
       let realTab = lastGoodTabGetter.tabs[tabIdx];
       if (realTab && realTab.label == tc[tabIdx].label) {
	  // Can't check for location match (because we have to send the frame script
	  // a message, so assume if the label hasn't changed on the tab, it's good.
	  let realCollector = lastGoodTabGetter.collector;
	  let realTabInfo = realCollector.tabs[tabIdx];
	  if (!realTabInfo) {
	     return false;
	  }
	  if (Debug) {
	     this.dump("QQQ: No need to update tab " + realTab.label + ", windowIdx" +
		       windowIdx + ", tabIdx: " + tabIdx);
	     //this.dump("QQQ: windowMatch: " + (lastGoodTabGetter.collector.openWindow == openWindow));
	     //this.dump("QQQ: tabMatch: " + (realTab == tc[tabIdx]));
	  }
	  // So update the tab collector directly
	  try {
	     let data = {tabIdx:tabIdx,
			 windowIdx:windowIdx,
			 timestamp:timestamp,
			 hasImage:false, // not kept
			 shortCircuitUpdate:true,
			 location:realTabInfo.location};
	     this.getTabs_dualProcessContinuation_aux({data: data});
	     return true;
	  } catch(ex) {
	     //@@@@
	     if (Debug) {
		this.dump("QQQ: Problem trying to update known tab: windowIdx:" + windowIdx +
			  " tabIdx: " + tabIdx + ", ex: " + ex + "ex.stack:" + ex.stack);
		this.dump("QQQ: No need to update tab " + realTab.label + ", windowIdx" +
			  windowIdx + ", tabIdx: " + tabIdx);
		this.dump("QQQ: windowMatch: " + (lastGoodTabGetter.collector.openWindow == openWindow));
		this.dump("QQQ: tabMatch: " + (realTab == tc[tabIdx]));
		this.dump("QQQ: tabGetter tab: <" + this.tabGetters[windowIdx].tabs[tabIdx] + ">");
	     }
	  }
       }
       return false;
     };

     this.getTabs_doneVisitingWindows = function() {
       if (ShowMetrics) {
	 this.ShowMetricsEndTime = new Date().valueOf();
	 this.dump("Time to visit all windows: " + (this.ShowMetricsEndTime - this.ShowMetricsStartTime) + " msec");
       }
       // We've visited all the tabs, now go start processing each one.
       // This function ends by sending a message to a frame script
       if (!this.madeRequest) {
	 // Call the final processor directly
	 if (Debug) {
	   this.dump("QQQ: No requests were made, so call dualProcessContinuationFinish directly")
	 }
	 this.dualProcessContinuationFinish();
	 return;
       }
       if (ShowMetrics) {
	 this.ShowMetricsProcessTabsStartTime = new Date().valueOf();
       }
       this.processTabsToQuery();

       // And set up the timeout to keep processing tabsToQuery if the current
       // frame script doesn't respond.
       let totalTimeout = 5 * 1000; // Update every 5 seconds regardless of # tabs
       let callbackTimeoutFunc = function(timestamp) {
	 if (Debug) {
	   this.dump("**** Hit callback timeout (" + (totalTimeout/1000) + " sec. before getting all the tabs -- " + this.tabsToQuery.length + " left to process");
	 }
	 if (timestamp < this.timestamp) {
	   if (Debug) {
	     this.dump("**** main callback timeout handler called too late: " + (this.timestamp - timestamp) + " msec");
	   }
	   return;
	 }
	 this.clearTimeouts();
	 this.dualProcessSetupFinalCallback({completedQuery:false, numTabs:this.numTabs});
	 // Maybe we'll get more later...
	 this.callbackTimeoutId = setTimeout(callbackTimeoutFunc, totalTimeout, timestamp);
	 if (this.tabsToQuery.length > 0) {
	    this.processTabsToQuery();
	 }
       }.bind(this);
       this.callbackTimeoutId = setTimeout(callbackTimeoutFunc, totalTimeout, this.timestamp);
     };

     // Visiting all the tabs this way: 60 tabs in 4 windows takes 1 msec,
     // vs. about 500 msec with 0-second setTimeout's.  So let's hog the CPU for
     // a short time, and just find all the info we need and get it done.
     this.visitAllTabs = function(openWindows) {
       var windowIdx = -1,
           openWindow, tabIdx, tc;
       this.numTabs = 0;
       this.madeRequest = false;
       this.tabGetters = [];
       while (openWindows.hasMoreElements()) {
	 if (!openWindows.hasMoreElements()) {
	   break;
	 }
	 openWindow = openWindows.getNext();
	 windowIdx += 1;
	 tc = openWindow.getBrowser().tabContainer.childNodes;
	 this.numTabs += tc.length;
	 this.tabGetters.push(new this.TabGetter(windowIdx, openWindow, tc));
	 for (tabIdx = 0; tabIdx < tc.length; tabIdx++) {
	    if (this.haveTabInfo(windowIdx, tabIdx, tc)) {
	       continue;
	    }
	    this.madeRequest = true;
	    this.tabsToQuery.push({windowIdx:windowIdx, tabIdx:tabIdx, openWindow:openWindow});
	 }
       }
       if (Debug) {
       this.dump("QQQ: Looper: picked up " + this.numTabs + " tabs in " + (windowIdx + 1) + " widows, queries: " + this.tabGetters.length);
       }
       this.getTabs_doneVisitingWindows();
     };

     // loops considered harmful in JS: use short-duration timeouts
     this.getNextTabFunc = function(timestamp, openWindows, openWindow, tc, windowIdx, tabIdx) {
       if (this.timestamp > timestamp) {
	 // A new query-loop started, so end this one.
	 // No need to cancel anything
	 if (Debug) {
	   this.dump("**** getNextTabFunc: processing a newer query at windowIdx: " +
		     this.windowIdx + ", tabIdx: " + tabIdx + " expired " +
		     (this.timestamp - timestamp) + " msec ago");
	 }
	 return;
       }
       makeRequest = !this.haveTabInfo(windowIdx, tabIdx, tc);
       if (makeRequest) {
	 this.madeRequest = true;
	 this.tabsToQuery.push({windowIdx:windowIdx, tabIdx:tabIdx, openWindow:openWindow});
       }
       if (tabIdx < tc.length - 1) {
	  setTimeout(this.getNextTabFuncBound, GET_TABS_ITERATE_DELAY, timestamp, openWindows, openWindow, tc, windowIdx, tabIdx + 1);
       } else if (openWindows.hasMoreElements()) {
	 let nextWindow = openWindows.getNext();
	 let tc = nextWindow.getBrowser().tabContainer.childNodes;
	 let nextWindowIdx = windowIdx + 1;
	 this.tabGetters.push(new this.TabGetter(nextWindowIdx, nextWindow, tc));
	 this.numTabs += tc.length;
	 if (Debug) {
	    this.dump("Window #" + nextWindowIdx + " has # tabs: " + tc.length);
	 }
	 setTimeout(this.getNextTabFuncBound, GET_TABS_ITERATE_DELAY, timestamp, openWindows, nextWindow, tc, nextWindowIdx, 0);
       } else {
	 this.getTabs_doneVisitingWindows();
       }
     };

     this.getNextTabFuncBound = this.getNextTabFunc.bind(this);
       
     this.processTabsToQuery = function() {
       if (this.tabsToQuery.length == 0) {
	 if (Debug) {
	 this.dump("TH: processTabsToQuery: this.tabsToQuery is empty");
	 }
	 return;
       }
       if (Debug) {
       this.dump("TH: #this.tabsToQuery: " + this.tabsToQuery.length);
       }
       var workItem = this.tabsToQuery.shift();
       //this.dump("QQQ: processTabsToQuery: workItem: " + (workItem && Object.keys(workItem).join(", ")))
       //this.dump("QQQ: processTabsToQuery: workItem: " + (workItem && Object.keys(workItem).join(", ")))
       if (ShowMetrics) {
	  this.singleQueryTimesCollector[this.timestamp + ":" + workItem.windowIdx + ":" + workItem.tabIdx] = new Date().valueOf();
       }
       this.tabGetters[workItem.windowIdx].setImageSetting(workItem.tabIdx, this.timestamp);
     };

   }).apply(tabCollector);

} catch(e) {
        var consoleService = Components.classes["@mozilla.org/consoleservice;1"]
                                       .getService(Components.interfaces.nsIConsoleService);
        consoleService.logStringMessage("th/tabCollector startup: " + e);
        consoleService.logStringMessage("th/tabCollector failure stack: " + e.stack);
}

