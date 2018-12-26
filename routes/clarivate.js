'use strict';
var request = require('request');
var express = require('express');
var router = express.Router();
var async = require('async');
var debug = require('debug')('portal:clarivate');
var tmp = require('tmp');
var fs = require('fs');
var util = require('util');
var utils = require('./utils');

router.get('/kong-status', function (req, res, next) {
  debug("get('/kong-status')");
  getAdmin(req, res, '/status', function (err, adminRes) {
    if (err) {
      return next(err);
    }

    var data = utils.getJson(adminRes.body);

    debug("Kong returned: " + JSON.stringify(data));

    var rows = [
      {'database_reachable': (data && data.database ? data.database.reachable : false),
       'server_connections_writing': (data && data.server ? data.server.connections_writing : -1),
       'server_total_requests': (data && data.server ? data.server.total_requests : -1),
       'server_connections_handled': (data && data.server ? data.server.connections_handled : -1),
       'server_connections_accepted': (data && data.server ? data.server.connections_accepted : -1),
       'server_connections_reading': (data && data.server ? data.server.connections_reading : -1),
       'server_connections_active': (data && data.server ? data.server.connections_active : -1),
       'server_connections_waiting': (data && data.server ? data.server.connections_waiting : -1)}
    ];

    res.json({status: rows});
  });
});

router.get('/status', function (req, res, next) {
  debug("get('/status')");
  utils.getFromAsync(req, res, '/apis', 200, function (err, apisResponse) {
     if (err)
         return next(err);
     var apiIds = [];
     var apis = apisResponse.apis;
     var apiHash = {};
     for (var i = 0; i < apis.length; ++i){
         apiIds.push(apis[i].id);
         apiHash[apis[i].id] = apis[i].name;
      }

     // This is the expensive part:
     async.map(apiIds, function (appiId, callback) {
       utils.getFromAsync(req, res, '/apis/' + appiId +'/config', 200, callback);
    }, function (err, apiConfigs) {
        if (err)
          return next(err);
        var uris = [];
        var apiStatus = [];
        for(var i = 0; i < apiConfigs.length; ++i){
          if(apiConfigs[i].api.uris){
            for(var j = 0; j < apiConfigs[i].api.uris.length; ++j){
              var uri = {}; var status = {};
              uri["url"] = apiConfigs[i].api.uris[j]+"/*";
              status["api"] = apiHash[apiConfigs[i].api.name];
              status["id"] = apiConfigs[i].api.name;
              status["path"] = apiConfigs[i].api.uris[j];
              uris.push(uri);
              apiStatus.push(status);
            }
          }
        }
      //Go find status
      getAPIStatus(req, res, uris, function (err, statusResponse) {
        if (err)
          return next(err);
          var body = statusResponse.body;
          for(var i = 0; i < body.length; ++i){
            apiStatus[i]["health"] = body[i].health;
            if(body[i].errorTypes)
              apiStatus[i]["errorTypes"] = body[i].errorTypes;
          }
          res.json({
            status: apiStatus
          });
      });
    });
  });
});

router.get('/subscriptions', function (req, res, next) {
	debug("get('/subscriptions')");
	if (req.query.filter && req.query.filter.consumerid) {
		getFilteredConsumerId(req, res);
	} else {
		getPortalUri(req, res,'/admin/subscriptions');
  }
});

router.post('/customheaders/:pluginId', function (req, res, next) {
  var body = utils.getJson(req.body);
  debug(req.body);
  var pluginId = req.params.pluginId;
  var key = body.key;
  var apiId = body.api;
  var headers = body.headers;
  var body_headers = body.body_headers;
  var pdata =  utils.getJson(body.pdata);
  var data=[];
  var foundExisting = false;
  if(pdata.headers){
    for (var i = 0; i < pdata.headers.length; ++i) {
      if(pdata.headers[i].key==key){
        pdata.headers[i].headers = utils.getJson(headers);
        foundExisting = true;
      }
      data.push(utils.getText(pdata.headers[i]));
    }
  }
  if(!foundExisting){
    data.push(utils.getText({"key": key, "headers":  utils.getJson(headers)}));
  }

  var myObject = {};
  var params = [];
  myObject["name"]= "custom-key-headers";
  myObject["config"] = {}
  for (var i = 0; i < data.length; ++i) {
    params.push(data[i]);
  }
  myObject["config"]["parameters"]=params;
  myObject["config"]["add_headers_to_body"]=body_headers.split(',').map(function(item) {
    return item.trim();
  });

  patchAdmin(req, res, '/plugins/'+pluginId, myObject, function (err, pluginsResponse) {
    if (err)
       return next(err);
    res.json(pluginsResponse);
  });
});

function getAPIStatus(req, res, data, callback) {
  var uri = "http://apps.dev-snapshot.clarivate.com/api/mapsResolver/strict";
  if(req.app.portalGlobals.network.apiStatusUrl){
    uri = req.app.portalGlobals.network.apiStatusUrl;
  }
  request.get(
    {
      url: uri,
      body: data,
      json: true,
    }, callback);
};

function getBaseUri(req){
  var baseUrl = "http://localhost:8001";
  if(req.app.portalGlobals.network.kongAdminUrl){
      baseUrl = req.app.portalGlobals.network.kongAdminUrl;
  }
  return baseUrl;
}

function patchAdmin(req, res, uri, data, callback) {
   var baseUrl =  getBaseUri(req);
   request.patch(
        {

            url: baseUrl + uri,
            body: data,
            json: true,
        },
        callback);
}


function getPortalUri(req, res, uri, callback) {
	let baseUrl = req.app.portalGlobals.network.portalUrl;
	request.get(
		{
			url: baseUrl + uri,
			json: true,
		});
};

function getAdmin(req, res, uri, callback) {
    var baseUrl =  getBaseUri(req);
    request.get(
        {
            url: baseUrl + uri
        },
        callback);
};

router.get('/customheaders/:apiId', function (req, res, next) {
  var apiId = req.params.apiId;
  var payload=[];
  var mbody_headers = [];
  getAdmin(req, res, '/services/'+apiId+'/plugins', function (err, pluginsResponse) {
     if (err)
       return next(err);
     var body = utils.getJson(pluginsResponse.body);
     var pid;
     if(!body.data) return;
     for (var i = 0; i < body.data.length; ++i) {
        var plugin_name = body.data[i].name;
        if(plugin_name === 'custom-key-headers'){
          var params = body.data[i].config.parameters;
          var bdyheaders = body.data[i].config.add_headers_to_body;
          mbody_headers  = (bdyheaders && bdyheaders.length > 0) ? bdyheaders.join() : mbody_headers;
          pid = body.data[i].id;
          for (var j = 0; j < params.length; ++j){
            payload.push(utils.getJson(params[j]));
          }
        }
     }
     res.json({ headers: payload, pluginid:  pid, body_headers: mbody_headers});
  });
});

router.post('/:appId/subscribe/:apiId', function (req, res, next) {
  debug("post('/:appId/subscribe/:apiId')");
  var appId = req.params.appId;
  var apiId = req.params.apiId;
  var apiPlan = req.body.plan;
  var apiKey = req.body.apikey;

  if (!apiPlan) {
      var err = new Error('Bad request. Plan was not specified.');
      err.status = 400;
      return next(err);
  }

  utils.delete(req, '/applications/' + appId + '/subscriptions/' + apiId,
      function (err, apiResponse, apiBody) {
          if (err)
              return next(err);
          if (204 != apiResponse.statusCode)
              return utils.handleError(res, apiResponse, apiBody, next);
              
          setTimeout(function() {
              utils.post(req, '/applications/' + appId + '/subscriptions',
                {
                  application: appId,
                  api: apiId,
                  apikey: apiKey,
                  plan: apiPlan
                }, function (err, apiResponse, apiBody) {
                  if (err)
                    return next(err);
                  if (201 != apiResponse.statusCode)
                    return utils.handleError(res, apiResponse, apiBody, next);
                  if (!utils.acceptJson(req))
                    res.redirect('/apis/' + apiId);
                  else
                    res.status(201).json(utils.getJson(apiBody));
              });
          }, 2000);
  });
});

module.exports = router;
