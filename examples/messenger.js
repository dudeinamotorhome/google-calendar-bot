'use strict';

var bodyParser = require('../node_modules/body-parser');
var express = require('../node_modules/express');
var request = require('../node_modules/request');
var Wit = require('../').Wit;
var fs = require('fs');
var readline = require('../node_modules/readline');
var google = require('../node_modules/googleapis');
var googleAuth = require('../node_modules/google-auth-library');
var date = require('../node_modules/date-utils');
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
const GOOGLE_SEARCH = 3;
const GOOGLE_DELETE_BUTTON = 4;


// environment variables
const PORT = process.env.PORT || 8445;                      // Webserver parameter
const WIT_TOKEN = 'FF3ZR7ZPW3OAOMFPKHN4ANI4DJFCGW3U';       // Wit.ai parameters
const FB_PAGE_ID = '1070859552993557';                       // Messenger API parameters

if (!FB_PAGE_ID) { throw new Error('missing FB_PAGE_ID'); }
const FB_PAGE_TOKEN = 'EAADqStRbwScBAEbQPmzkAOr1csR6qWwB9DX2bcGZCb9ldooOArRAoq6Wvdtlgd6gL8ZAbqZBnsxcrzHlnVw1dzyKhn6MaRMer3339rlMZATdBPMyDhhYqu6cYFYr2u7H7awKNsvxKO8Rr2tf7elZA0Lu8uGabVBOcPJOvlAKE3gZDZD';                               // Facebook Page token
//  'EAADqStRbwScBAI1KKOR1HwB9vpBG41WUMX' +
//  'iKKo5OySlknWIi5WhErbR4gI4zvwQTb2STA' +
//  'Q0JqoWeFfEDvvL67eYEZCRI24bL9vfwOS4w' +
//  'QJty5O95VSiFjL1yRrtcTgULH4PxJI93Lej' +
//  'D1pZBHsuWqqcdibmpldmZBZCu4oZAz8wZDZD';
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
  say_hello,
  converse_search_user,
  google_show,
  google_insert,
  google_search,
  google_delete
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
  
  if(messaging && messaging.postback && messaging.recipient.id === FB_PAGE_ID){
    
    const sender = messaging.sender.id;
    const sessionId = findOrCreateSession(sender);
    var delete_id = messaging.postback.payload;
    
    postback_delete(sessionId, delete_id, null);
  }
  
  
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
            fbMessage(sender, "Fail to User authentication.");
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
      fbMessage(sender, "Access Key Timeout. Try again :'(.");
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
                          'What should i do for you :D?');
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
    console.log("datetime : at");
    context.datetime = firstEntityValue(entities, "datetime");
  }
  if(firstEntityValue(entities, "from") && firstEntityValue(entities, "to")) {
    console.log("datetime : from ~ to");
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


function say_hello(sessionId, context, cb) {
  const recipientId = sessions[sessionId].fbid;
  if(recipientId) {
    fbMessage(recipientId, "Hello~ :D\n");
  }
}


function converse_search_user(sessionId, context, cb) {
  // 여기서 유저 정보 디비에서 가져와서
  // fbMessage로 몇 번째 방문인지 보여줌
  const recipientId = sessions[sessionId].fbid;
  if(recipientId) {
    var visit_count = db.db_getUserVisit(sender);
    if(visit_count == null)
      visit_count = 0;
    fbMessage(recipientId, "you visited " + visit_count + "time\n. yay~");
  }
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
      authorize(sessionId, context, cb, JSON.parse(content), GOOGLE_INSERT);
    });
  }
}


function google_search(sessionId, context, cb) {
  const recipientId = sessions[sessionId].fbid;
  sender = recipientId;
  if (recipientId) {
    fs.readFile(process.env.HOME + '/workspace/node-wit/' + 'client_secret.json', function processClientSecrets(err, content) {
      if (err) {
        console.log('Error loading client secret file: ' + err);
        return;
      }
      authorize(sessionId, context, cb, JSON.parse(content), GOOGLE_SEARCH);
    });
  }
}

function google_delete(sessionId, context, cb) {
  const recipientId = sessions[sessionId].fbid;
  sender = recipientId;
  if (recipientId) {
    fs.readFile(process.env.HOME + '/workspace/node-wit/' + 'client_secret.json', function processClientSecrets(err, content) {
      if (err) {
        console.log('Error loading client secret file: ' + err);
        return;
      }
      authorize(sessionId, context, cb, JSON.parse(content), GOOGLE_DELETE);
    });
  }
}

function postback_delete(sessionId, context, cb){
  const recipientId = sessions[sessionId].fbid;
  sender = recipientId;
  if (recipientId) {
    fs.readFile(process.env.HOME + '/workspace/node-wit/' + 'client_secret.json', function processClientSecrets(err, content) {
      if (err) {
        console.log('Error loading client secret file: ' + err);
        return;
      }
      authorize(sessionId, context, cb, JSON.parse(content), GOOGLE_DELETE_BUTTON);
    });
  }
}

function delete_event(auth, context, cb){
   var calendar = google.calendar('v3');
  calendar.events.delete({
                  auth : auth,
                  calendarId: 'primary',
                  eventId : context,
                }, function(err, calendars){
                  if(err){ 
                    console.log(err);
                    fbMessage(sender, "Delete Fail :poop:.\n");
                  }
                   else fbMessage(sender, "Ok, Your schedule is deleted :D.\n");
                });
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
                            "Please try after a minute again :'(.");
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
      case GOOGLE_DELETE:
        search_for_delete(oauth2Client, context, cb);
        break;
      case GOOGLE_DELETE_BUTTON:
        delete_event(oauth2Client, context, cb);
        break;
      case GOOGLE_SEARCH:
        search(oauth2Client, context, cb);
        break;
      default:
        break;
    }
  });
}


function show(auth, context, cb){
  if(!context.datetime) {
    fbMessage(sender, "I can't not read your schedule date :(.\n\n" +
                      "Please input correct date format." );
    return;
  }
  
  fbMessage(sender, "Ok, I'll get your schedule :D.\n");
 
 console.log(new Date(context.datetime[0]).addHours(9).toISOString());
 console.log(new Date(context.datetime[1]).addHours(33).toISOString());
 
  var calendar = google.calendar('v3');
  calendar.events.list({
    auth: auth,
    calendarId: 'primary',
    timeMin: (Array.isArray(context.datetime) ? new Date(context.datetime[0]).addHours(33).toISOString() : new Date(context.datetime).addHours(9).toISOString()),
    timeMax: (Array.isArray(context.datetime) ? new Date(context.datetime[1]).addHours(33).toISOString() : new Date(context.datetime).addHours(33).toISOString()),
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
      result_event += 'Upcoming ' + events.length +' events : \n\n';
      for (var i = 0; i < events.length; i++) {
        var event = events[i];
        var start = event.start.dateTime || event.start.date;
        var date = new Date(start).addHours(9).toLocaleDateString() + "  " + new Date(start).addHours(9).toLocaleTimeString();
        
       // console.log('%s - %s', date, event.summary);
      
        if((result_event + date + "  -  " +  event.summary +"\n").length > 320) {
          fbMessage(sender,  result_event);
          result_event = "";
        }
         result_event += date + "  -  " + event.summary + "\n";
      }
      
      if(result_event.length > 0) 
        fbMessage(sender,  result_event);
    }
  });
}

function insert(auth, context, cb){
  if(!context.message_subject || !context.datetime) {
    fbMessage(sender, "I can't not read your schedule title :(.\n\n" +
                      "Please send me \"schedule's 'title' at datetime\" 'title' format." );
    return;
  }
  
  
  
  var date = new Date(context.datetime).addDays(1).toLocaleDateString();
  var time = new Date(context.datetime).toLocaleTimeString();
  
  var event = {
    'summary': context.message_subject,
    'location': '',
    'description': '',
    'start': {
      'dateTime': (Array.isArray(context.datetime) ? new Date(context.datetime[0]).addDays(1).toISOString() :  new Date(context.datetime).addHours(9).toISOString()),
      //'dateTime': context.datetime,
      'timeZone': 'America/Los_Angeles',
    },
    'end': {
      'dateTime': (Array.isArray(context.datetime) ? new Date(context.datetime[1]).addDays(1).toISOString() : new Date(context.datetime).addHours(33).toISOString()),
      //'dateTime': new Date(context.datetime).addDays(1).toISOString(),
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
    fbMessage(sender, 
              "['" + context.message_subject + "'" + 
              " at " + date + " - " + time +
              "] insert success (y).");
  });
}


function search(auth, context, cb){
   if(!context.message_subject){
    fbMessage(sender, "I can't not read your schedule title :(.\n\n" +
                      "Please input your schedule's title 'title' format." );
    return;
  }
  
  fbMessage(sender, "ok, I'm searching '" + context.message_subject +"'...\n");
  
  var calendar = google.calendar('v3');
      calendar.events.list({
        auth : auth,
        calendarId: 'primary',
        timeMin: (new Date().addDays(-90).toISOString() ),
      }, function(err, events){
        if(err) console.log(err);
     
        console.log(events.items.length);
        var detect_count =0;
        var result_event ="";
        
        for(var i=0; i<events.items.length; i++){
            if(events.items[i].summary === context.message_subject){
                var start = events.items[i].start.dateTime || events.items[i].start.date;
                var date = new Date(start).toLocaleDateString() + "  " + new Date(start).toLocaleTimeString();
                if((result_event + date + "  -  " +  events.items[i].summary +"\n").length > 320) {
                      fbMessage(sender,  result_event);
                      result_event = "";
                }
                     result_event += date + "  -  " + events.items[i].summary + "\n";
                }
        }
              if(result_event.length > 0) 
                fbMessage(sender,  result_event);
              else if(result_event.length == 0)
                      fbMessage(sender,  "I can't search. No matching schedule :O.");
              fbMessage(sender, "Done\n");
      });
}


function search_for_delete(auth, context, cb){
   if(!context.message_subject){
    fbMessage(sender, "I can't not read your schedule title :(.\n\n" +
                      "Please input your schedule's title 'title' format." );
    return;
  }
  
  fbMessage(sender, "Ok, I'm searching '" + context.message_subject +"'...\n");
  
  var calendar = google.calendar('v3');
      calendar.events.list({
        auth : auth,
        calendarId: 'primary',
        timeMin: (new Date().addDays(-90).toISOString() ),
      }, function(err, events){
        if(err) console.log(err);
     
        console.log(events.items.length);
        var result_event ="";
        var search_id =[];
        var search_title =[];
        var search_date =[];
        for(var i=0; i<events.items.length; i++) {
            if(events.items[i].summary === context.message_subject){
                search_id.push(events.items[i].id);
                search_title.push(events.items[i].summary);
                search_date.push(new Date(events.items[i].start.dateTime).toLocaleDateString());
            }
        }
        
        delete_button(sender, search_id,search_title,search_date);
      });
}



function delete_button(sender,search_id,search_title,search_date) {
  console.log(search_id.length);
  console.log(parseInt( (search_id.length)/3) +1);
  
  if(search_id.length < 1) {
    fbMessage(sender, "You don't have that event. zzz\n");
    return;
  }
  
  /*
  var button = [];
  
  for(var i = 0; i < search_id.length && i < 3; ++i) {
    button.push({
              type: "postback",
              title: search_date[i] + " - " + search_title[i] ,
              payload: search_id[i],
            });
  }
  
  var messageData = {
    "attachment": {
      "type": "template",
      "payload": {
        "template_type": "generic",
        "elements": [{
          "title": "Delete schedule",
          "subtitle": "Select schedule to delete",
          "buttons": button,
        }]
      }
    }
  };
  
  */
  
  var element = [];
  
  for(var i = 0; i < search_id.length / 3; ++i) {
    
    var button = [];
    
    for(var j = i * 3; j < search_id.length & j < i * 3 + 3; ++j) {
      button.push({
        type: "postback",
        title: search_date[j] + " - " + search_title[j] ,
        payload: search_id[j],
      });
    }
    
    element.push({
      "title": "Delete schedule",
      "subtitle": "Select schedule to delete",
      "buttons": button,
    });
    
    console.log(button);
  }
  
  var messageData = {
    "attachment": {
      "type": "template",
      "payload": {
        "template_type": "generic",
        "elements": element,
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
