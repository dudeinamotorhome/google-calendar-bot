'use strict';

var bodyParser = require('body-parser');
var express = require('express');
var request = require('request');
var Wit = require('../').Wit;
var fs = require('fs');
var readline = require('readline');
var google = require('googleapis');
var googleAuth = require('google-auth-library');
var date = require('date-utils');
var db = require('./mongodb.js');


// global variables
var sender;
var verify = 0;
var verify_sender;
var verify_timer;
var SCOPES = ['https://www.googleapis.com/auth/calendar'];
var TOKEN_DIR = (process.env.HOME || 
                  process.env.HOMEPATH || 
                  process.env.USERPROFILE) + '/.credentials';
var TOKEN_PATH;
var oauth2Client;


// command code
const GOOGLE_SHOW = 0;
const GOOGLE_INSERT = 1;
const GOOGLE_DELETE = 2;


// environment variables
const PORT = process.env.PORT || 8445;                      // Webserver parameter
const WIT_TOKEN = 'FF3ZR7ZPW3OAOMFPKHN4ANI4DJFCGW3U';       // Wit.ai parameters
const FB_PAGE_ID = '237759059939761';                       // Messenger API parameters
if (!FB_PAGE_ID) { throw new Error('missing FB_PAGE_ID'); }
const FB_PAGE_TOKEN =                                       // Facebook Page token
  'EAADqStRbwScBAI1KKOR1HwB9vpBG41WUMX' +
  'iKKo5OySlknWIi5WhErbR4gI4zvwQTb2STA' +
  'Q0JqoWeFfEDvvL67eYEZCRI24bL9vfwOS4w' +
  'QJty5O95VSiFjL1yRrtcTgULH4PxJI93Lej' +
  'D1pZBHsuWqqcdibmpldmZBZCu4oZAz8wZDZD';
if (!FB_PAGE_TOKEN) { throw new Error('missing FB_PAGE_TOKEN'); }
const FB_VERIFY_TOKEN = 'ajou_project';                     // Facebook Verify token



// Starting our webserver and putting it all together
const app = express();
app.set('port', PORT);
app.listen(app.get('port'));
app.use(bodyParser.json());







/*************************************************************
 * 
 * 
 * 
 *                        API specific code
 * 
 *
 * 
 */
// Send API
// https://developers.facebook.com/docs/messenger-platform/send-api-reference
const fbReq = request.defaults({
  uri: 'https://graph.facebook.com/me/messages',
  method: 'POST',
  json: true,
  qs: { access_token: FB_PAGE_TOKEN },
  headers: {'Content-Type': 'application/json'},
});

const fbMessage = (recipientId, msg, cb) => {
  const opts = {
    form: {
      recipient: {
        id: recipientId,
      },
      message: {
        text: msg,
      },
    },
  };
  fbReq(opts, (err, resp, data) => {
    if (cb) {
      cb(err || data.error && data.error.message, data);
    }
  });
};


// See the Webhook reference
// https://developers.facebook.com/docs/messenger-platform/webhook-reference
const getFirstMessagingEntry = (body) => {
  const val = body.object == 'page' &&
    body.entry &&
    Array.isArray(body.entry) &&
    body.entry.length > 0 &&
    body.entry[0] &&
    body.entry[0].id === FB_PAGE_ID &&
    body.entry[0].messaging &&
    Array.isArray(body.entry[0].messaging) &&
    body.entry[0].messaging.length > 0 &&
    body.entry[0].messaging[0]
  ;
  return val || null;
};


// Wit.ai bot specific code
const actions = {       // Our bot actions
  say,
  merge,
  error,
  converse_search_user,
  google_show,
  google_insert
};


const wit = new Wit(WIT_TOKEN, actions);  // Setting up our bot


const sessions = {};    // This will contain all user sessions.
                        // sessionId -> {fbid: facebookUserId, context: sessionState}
                        // Each session has an entry:
const findOrCreateSession = (fbid) => {
  let sessionId;
  Object.keys(sessions).forEach(k => {
    if (sessions[k].fbid === fbid) {
      sessionId = k;
    }
  });
  if (!sessionId) {
    sessionId = new Date().toISOString();
    sessions[sessionId] = {fbid: fbid, context: {}};
  }
  return sessionId;
};

const firstEntityValue = (entities, entity) => {
  const val = entities && entities[entity] &&
    Array.isArray(entities[entity]) &&
    entities[entity].length > 0 &&
    entities[entity][0].value;
  if (!val) {
    return null;
  }
  return typeof val === 'object' ? val.value : val;
};


// Webhook setup
app.get('/fb', (req, res) => {
  if (!FB_VERIFY_TOKEN) {
    throw new Error('missing FB_VERIFY_TOKEN');
  }
  if (req.query['hub.mode'] === 'subscribe' &&
    req.query['hub.verify_token'] === FB_VERIFY_TOKEN) {
    res.send(req.query['hub.challenge']);
  } else {
    res.sendStatus(400);
  }
});


// Image URL to show calendar image
app.get('/image/googlecalendar', function (req, res) {
  var img = fs.readFileSync('/home/ubuntu/workspace/node-wit/img/googlecalendar.jpg');
  res.writeHead(200, {'Content-Type': 'image/jpg' });
  res.end(img, 'binary');
});


// Message handler
app.post('/fb', (req, res) => {
  const messaging = getFirstMessagingEntry(req.body);
  if (messaging && messaging.message && messaging.recipient.id === FB_PAGE_ID) {

    const sender = messaging.sender.id;
    const sessionId = findOrCreateSession(sender);
    const msg = messaging.message.text;
    const atts = messaging.message.attachments;

    if(verify == 1 && verify_sender == sender) {
      oauth2Client.getToken(msg, function(err, token) {
        if (err) {
          console.log('Error while trying to retrieve access token', err);
          fbMessage(sender, "Your access key is not valid.");
          if(verify==3){
            verify = 0;
            clearTimeout(verify_timer);
            fbMessage(sender, "Fail zzzto User authentication.");
          } else {
            verify++;
            fbMessage(sender, "Your chance remain " + (4-verify) +".");
          }
          return;
        }
        oauth2Client.credentials = token;
        storeToken(sender, token);
      });
    }
  
    if (atts) {
      fbMessage(sender, 'Sorry I can only process text messages for now.');
    } else if (msg) {
      wit.runActions(
        sessionId,                    // the user's current session
        msg,                          // the user's message 
        sessions[sessionId].context,  // the user's current session state
        (error, context) => {
          if (error) {
            console.log('Oops! Got an error from Wit:', error);
          } else {
            console.log('Waiting for futher messages.');

            // Based on the session state, you might want to reset the session.
            // This depends heavily on the business logic of your bot.
            // Example:
            // if (context['done']) {
            //   delete sessions[sessionId];
            // }

            sessions[sessionId].context = context;
          }
        }
      );
    }
  }
  res.sendStatus(200);
});









/*************************************************************
 * 
 * 
 * 
 *                        functions
 * 
 *
 * 
 */


function getNewToken(sender, oauth2Client) {
  var authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES
  });
  post_access_url(sender, authUrl);
  verify = 1;
  verify_sender = sender; 
  verify_timer = setTimeout(function() {
      fbMessage(sender, "Access Key Timeout. Try again.");
      verify = 0;
      verify_sender = 0;
    },
    20*1000);
}


function storeToken(sender, token) {
  fs.mkdir(TOKEN_DIR + '/' + verify_sender, function(err) {
    if(err) throw err;
  });
  TOKEN_PATH = TOKEN_DIR + '/' + verify_sender + '/calendar-nodejs-quickstart.json';
  try {
    fs.mkdirSync(TOKEN_DIR);
  } catch (err) {
    if (err.code != 'EEXIST') {
      throw err;
    }
  }
  
  fs.writeFile(TOKEN_PATH, JSON.stringify(token));
  db.db_addCredential(sender);
  db.db_addUser(sender);
  
  clearTimeout(verify_timer);
  fbMessage(verify_sender, 'Now we can access your calendar!\n' + 
                          'What should i do for you?');
  verify = 0;
  verify_sender = 0;
}


function post_access_url(sender, url) {
  var messageData = {
    "attachment": {
      "type": "template",
      "payload": {
        "template_type": "generic",
        "elements": [{
          "title": "Google Calendar",
          "subtitle": "Please enter your access key.",
          "image_url": "https://db-project-bot-bee0005.c9users.io/image/googlecalendar",
          "buttons": [{
            "type": "web_url",
            "url": url,
            "title": "Access Key"
          }],
        }]
      }
    }
  };
  request({
    url: 'https://graph.facebook.com/v2.6/me/messages',
    qs: {access_token: FB_PAGE_TOKEN },
    method: 'POST',
    json: {
      recipient: {id:sender},
      message: messageData,
    }
  }, function(error, response, body) {
    if (error) {
      console.log('Error sending message: ', error);
    } else if (response.body.error) {
      console.log('Error: ', response.body.error);
    }
  });
}


function say(sessionId, context, message, cb) {
  const recipientId = sessions[sessionId].fbid;
  if (recipientId) {
   // fbMessage(recipientId, "Sorry. I can't understand your sentence.. :(", (err, data) => {
    fbMessage(recipientId, message, (err, data) => {
      if (err) {
        console.log(recipientId, ':', err);
      }
      cb(); // Let's give the wheel back to our bot
    });
  } else {
    cb(); // Giving the wheel back to our bot
  }
}

function merge(sessionId, context, entities, message, cb) {
  
  if(firstEntityValue(entities, "datetime")) {
    context.datetime = firstEntityValue(entities, "datetime");
  }
  if(firstEntityValue(entities, "from") && firstEntityValue(entities, "to")) {
    context.datetime = [
      firstEntityValue(entities, "from"), 
      firstEntityValue(entities, "to")
      ];
  }
  if(firstEntityValue(entities, "message_subject")) {
    context.message_subject = firstEntityValue(entities, "message_subject");
  }
  
  cb(context);
}


function error(sessionId, context, error) {
  console.log(error.message);
}


function converse_search_user(sessionId, context, cb) {
  // 여기서 유저 정보 디비에서 가져와서
  db.db_getUser(sender);
  // fbMessage로 몇 번째 방문인지 보여줌
}


function google_show(sessionId, context, cb) {
  const recipientId = sessions[sessionId].fbid;
  sender = recipientId;
  if (recipientId) {
    fs.readFile(process.env.HOME + '/workspace/node-wit/' + 'client_secret.json', function processClientSecrets(err, content) {
      if (err) {
        console.log('Error loading client secret file: ' + err);
        return;
      }
      authorize(sessionId, context, cb, JSON.parse(content), GOOGLE_SHOW);
    });
  }
  cb();
}

function google_insert(sessionId, context, cb) {
  const recipientId = sessions[sessionId].fbid;
  sender = recipientId;
  if (recipientId) {
    fs.readFile(process.env.HOME + '/workspace/node-wit/' + 'client_secret.json', function processClientSecrets(err, content) {
      if (err) {
        console.log('Error loading client secret file: ' + err);
        return;
      }
      authorize(sessionId, context, cb, JSON.parse(content), GOOGLE_SHOW);
    });
  }
  cb();
}


function authorize(sessionId, context, cb, credentials, command) {
  const clientSecret = credentials.installed.client_secret;
  const clientId = credentials.installed.client_id;
  const redirectUrl = credentials.installed.redirect_uris[0];
  const auth = new googleAuth();
  const sender = sessions[sessionId].fbid;

  oauth2Client = new auth.OAuth2(clientId, clientSecret, redirectUrl);
  TOKEN_PATH = TOKEN_DIR + '/' + sender + '/calendar-nodejs-quickstart.json';
  fs.readFile(TOKEN_PATH, function(err, token) {
    if (err) {
      if(verify != 0) {
        fbMessage(sender,  "We need authorized your key, " + 
                            "but other user Registering now.\n" +
                            "Please try after a minute again.");
        return;
      }
      getNewToken(sender, oauth2Client);
      return;
    }
    oauth2Client.credentials = JSON.parse(token);
    
    switch (command) {
      case GOOGLE_SHOW:
        show(oauth2Client, context, cb);
        break;
      case GOOGLE_INSERT:
        insert(oauth2Client, context, cb);
        break;
      default:
        break;
    }
  });
}


function show(auth, context, cb){
  var calendar = google.calendar('v3');
  calendar.events.list({
    auth: auth,
    calendarId: 'primary',
    timeMin: (Array.isArray(context.datetime) ? context.datetime[0] : context.datetime),
    timeMax: (Array.isArray(context.datetime) ? context.datetime[1] : new Date(context.datetime).addDays(1).toISOString()),
    maxResults: 10,
    singleEvents: true,
    orderBy: 'startTime'
  }, function(err, response) {
    if (err) {
      console.log('The API returned an error: ' + err);
      fbMessage(sender, 'Sorry, we got an error... :(');
      return;
    }
    var events = response.items;
    if (events.length == 0) {
      fbMessage(sender,  'No upcoming events found.');
    } else {
      console.log('Upcoming 10 events : ');
    
      var result_event ="";
      result_event += 'Upcoming ' + 10 +' events : \n\n';
      for (var i = 0; i < events.length; i++) {
        var event = events[i];
        var start = event.start.dateTime || event.start.date;
        console.log('%s - %s', start, event.summary);
      
        if((result_event + start + "  -  " +  event.summary +"\n").length > 320) {
          fbMessage(sender,  result_event);
          result_event = "";
        }
        result_event += start + "  -  " + event.summary + "\n";
      }
      
      if(result_event.length > 0) 
        fbMessage(sender,  result_event);
    }
    cb();
  });
}


function insert(auth, context, cb){
  var event = {
    'summary': context.message_subject,
    'location': '',
    'description': '',
    'start': {
      'dateTime': context.datetime,
      'timeZone': 'America/Los_Angeles',
    },
    'end': {
      'dateTime': new Date(context.datetime).addDays(1).toISOString(),
      'timeZone': 'America/Los_Angeles',
    },
  };
  var calendar = google.calendar('v3');
  calendar.events.insert({
    auth: auth,
    calendarId: 'primary',
    resource: event,
  }, function(err, event) {
    if (err) {
      console.log('There was an error contacting the Calendar service: ' + err);
      fbMessage(sender, 'Sorry, we got an error... :(');
      return;
    }
    console.log('Event created: %s', event.htmlLink);
    fbMessage(sender,  "insert schedule success");
  });
  cb();
}