/**
 * @name test.core.draft
 * @namespace Tests for core.draft.
 */
define(["dao", "db", "globals", "core/league", "core/freeAgents", 'lib/underscore'], function (dao, db, g, league, fa, _) {
    "use strict";

    describe("core/freeAgents", function () {
        var oBaseMoods;
        before(function () {
            return db.connectMeta().then(function () {
                return league.create("Test", 20, undefined, 2015, false);
            });
        });

        before(function() {
            var tx = dao.tx(['gameAttributes'], 'readwrite', tx);
            return require("core/league").setGameAttributes(tx, {daysLeft: 30});
        });
        after(function () {
            return league.remove(g.lid);
        });

        describe('cpuResignPlayers', function() {
            it('should resign players.', function() {
                var player, team, tx;
                tx = dao.tx(["gameAttributes", "messages", "negotiations", "players", "playerStats", "releasedPlayers", "teams"], "readwrite");

                player = require('core/player');
                team = require('core/team');
                // to have fuzzValue and strategy updated.
                return team.updateStrategies(tx)
                .then(function() {
                    return player.genBaseMoods(tx)
                })
                .then(function(baseMoods) {
                    oBaseMoods = baseMoods;
                    return fa.cpuResignPlayers(tx, baseMoods);
                });
            });
        });

        describe('readyTeamsFA', function() {
            it('should ready teams for FA', function() {
                return fa.readyTeamsFA();
            });
        });

        describe('readyPlayersFA', function() {
            it('should ready players for FA', function() {
                return fa.readyPlayersFA(null, oBaseMoods);
            });
        });

        describe('tickFreeAgencyDay', function() {
            it('should do task for a FA day', function() {
                var Promise = require('lib/bluebird');
                return Promise.each(_.range(30), function() {
                    return fa.tickFreeAgencyDay()
                        .then(function() {
                            return require("core/league").setGameAttributesComplete({daysLeft: g.daysLeft - 1, lastDbChange: Date.now()});
                        });
                });
            });
        });

        describe('test', function() {
            it.skip('should work', function() {
                var p, player, v;
                player = require('core/player');
                p = {value: 80, valueNoPot: 70, ratings: [{ovr: 65, pot: 90}],
                    draft: {year: 2014}, born: {year: 1995}};
                v = player.cpuValue(p, 10.5);
                v = player.cpuGenContract(p, 2.5);
                console.log(v);
            });
        });
    });
});
