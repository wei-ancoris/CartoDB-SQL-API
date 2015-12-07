'use strict';

var _ = require('underscore');
var step = require('step');
var assert = require('assert');
var PSQL = require('cartodb-psql');
var uuid = require('uuid');

var UserDatabaseService = require('../services/user_database_service');
var CdbRequest = require('../models/cartodb_request');
var handleException = require('../utils/error_handler');

var cdbReq = new CdbRequest();
var userDatabaseService = new UserDatabaseService();

function JobController(metadataBackend, tableCache, statsd_client) {
    this.metadataBackend = metadataBackend;
    this.tableCache = tableCache;
    this.statsd_client = statsd_client;
}

JobController.prototype.route = function (app) {
    app.all(global.settings.base_url + '/job',  this.handleJob.bind(this));
};

// jshint maxcomplexity:21
JobController.prototype.handleJob = function (req, res) {
    var self = this;
    var body = (req.body) ? req.body : {};
    var params = _.extend({}, req.query, body); // clone so don't modify req.params or req.body so oauth is not broken
    var sql = (params.q === "" || _.isUndefined(params.q)) ? null : params.q;
    var cdbUsername = cdbReq.userByReq(req);

    if (!_.isString(sql)) {
        return handleException(new Error("You must indicate a sql query"), res);
    }

    if ( req.profiler ) {
        req.profiler.start('sqlapi.job');
    }

    req.aborted = false;
    req.on("close", function() {
        if (req.formatter && _.isFunction(req.formatter.cancel)) {
            req.formatter.cancel();
        }
        req.aborted = true; // TODO: there must be a builtin way to check this
    });

    function checkAborted(step) {
      if ( req.aborted ) {
        var err = new Error("Request aborted during " + step);
        // We'll use status 499, same as ngnix in these cases
        // see http://en.wikipedia.org/wiki/List_of_HTTP_status_codes#4xx_Client_Error
        err.http_status = 499;
        throw err;
      }
    }

    var pg;

    if ( req.profiler ) {
        req.profiler.done('init');
    }

    step(
        function getUserDBInfo() {
            var options = {
                req: req,
                params: params,
                checkAborted: checkAborted,
                metadataBackend: self.metadataBackend,
                cdbUsername: cdbUsername
            };
            userDatabaseService.getUserDatabase(options, this);
        },
        function enqueueJob(err, userDatabase) {
            assert.ifError(err);

            var next = this;

            checkAborted('enqueueJob');

            if ( req.profiler ) {
                req.profiler.done('setDBAuth');
            }

            pg = new PSQL(userDatabase, {}, { destroyOnError: true });

            var enqueueJobQuery = [
                'INSERT INTO cdb_jobs (',
                    'user_id, query',
                ') VALUES (',
                    '\'' + cdbUsername + '\', ',
                    '\'' + sql + '\' ',
                ');'
            ].join('\n');

            pg.query(enqueueJobQuery, function (err, result) {
                if (err) {
                    return next(err);
                }
                next(null, {
                    job: result,
                    host: userDatabase.host
                });
            });
        },
        function handleResponse(err, result) {
            if ( err ) {
                handleException(err, res);
            }

            if ( req.profiler ) {
                req.profiler.done('enqueueJob');
                res.header('X-SQLAPI-Profiler', req.profiler.toJSONString());
            }

            if (global.settings.api_hostname) {
              res.header('X-Served-By-Host', global.settings.api_hostname);
            }

            if (result.host) {
              res.header('X-Served-By-DB-Host', result.host);
            }

            res.send({
                job_id: result.job.job_id
            });
        }
    );
};

module.exports = JobController;
