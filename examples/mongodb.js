var MongoClient = require('mongodb').MongoClient;

var db_port = 27017;
var db_ip   = process.env.IP;

exports.db_addCredential = function (sender_id) {
  MongoClient.connect("mongodb://"+db_ip+":"+db_port+"/ROOT", function(error, db) {
    if(!error){
      // query 실행
      var collection = db.collection('credential');
      collection.insert({facebook_id: sender_id, date: (new Date()).toISOString()});
    }
    else{
      console.dir(error); //failed to connect to [127.4.68.129:8080]
    }
  });
};

exports.db_addUser = function (sender_id) {
  MongoClient.connect("mongodb://"+db_ip+":"+db_port+"/ROOT", function(error, db) {
    if(!error){
      // query 실행
      var collection = db.collection('user');
      collection.insert({facebook_id: sender_id, 
                          lastVisit: (new Date()).toISOString(), 
                          visitCount: 0, 
                          viewCount: 0, 
                          insertCount: 0, 
                          deleteCount: 0});
    }
    else{
      console.dir(error); //failed to connect to [127.4.68.129:8080]
    }
  });
};

exports.db_getUser = function (sender_id) {
  MongoClient.connect("mongodb://"+db_ip+":"+db_port+"/ROOT", function(error, db) {
    if(!error){
      // query 실행
      var collection = db.collection('user');
     console.log("@@@@@@@converse_search_user@@@@@@@");
     // console.log(collection.find({facebook_id : sender_id}));
    }
    else{
     console.log("#################");
      console.dir(error); //failed to connect to [127.4.68.129:8080]
    }
    return null;
  });
};