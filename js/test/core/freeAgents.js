/**
 * @name test.core.draft
 * @namespace Tests for core.draft.
 */
define(["dao", "db", "globals", "core/league", "core/freeAgents"], function (dao, db, g, league, fa) {
    "use strict";

    describe("core/freeAgents", function () {
        before(function () {
            return db.connectMeta().then(function () {
                return league.create("Test", 20, undefined, 2015, false)
            });
        });
        before(function () {
            var tx, player;
            tx = dao.tx(['players', 'releasedPlayers', 'teams'], 'readwrite');
            player = require('core/player');
            return player.genBaseMoods(tx)
                .then(function(baseMoods) {
                    return dao.players.iterate({
                        ot: tx,
                        index: "tid",
                        key: IDBKeyRange.lowerBound(1),
                        callback: function(p) {
                            var contract;
                            if (p.contract.exp <= g.season) {
                                contract = player.genContract(p);
                                contract.exp += 1;
                                p = player.setContract(p, contract, false);
                                player.addToFreeAgents(tx, p, g.PHASE.RESIGN_PLAYERS, baseMoods);
                            }
                            return p;
                        }
                    });
                });
        });
        before(function() {
            var tx = dao.tx(['gameAttributes'], 'readwrite', tx);
            return require("core/league").setGameAttributes(tx, {daysLeft: 30});
        });
        after(function () {
            return league.remove(g.lid);
        });

        describe('readyTeamsFA', function() {
            it('should ready teams for FA', function() {
                return fa.readyTeamsFA();
            });
        });

        describe('readyPlayersFA', function() {
            it('should ready players for FA', function() {
                return fa.readyPlayersFA();
            });
        });

        describe('tickFreeAgencyDay', function() {
            it('should do task for a FA day', function() {
                return fa.tickFreeAgencyDay()
                    .then(function() {
                        return fa.tickFreeAgencyDay();
                    })
                    .then(function() {
                        return fa.tickFreeAgencyDay();
                    })
                    .then(function() {
                        return fa.tickFreeAgencyDay();
                    })
                    .then(function() {
                        return fa.tickFreeAgencyDay();
                    })
                    .then(function() {
                        return fa.tickFreeAgencyDay();
                    })
                    .then(function() {
                        return fa.tickFreeAgencyDay();
                    })
                    .then(function() {
                        return fa.tickFreeAgencyDay();
                    })
                    .then(function() {
                        return fa.tickFreeAgencyDay();
                    })
                    .then(function() {
                        return fa.tickFreeAgencyDay();
                    })
                    .then(function() {
                        return fa.tickFreeAgencyDay();
                    })
                    .then(function() {
                        return fa.tickFreeAgencyDay();
                    })
                    .then(function() {
                        return fa.tickFreeAgencyDay();
                    })
                    .then(function() {
                        return fa.tickFreeAgencyDay();
                    })
                    .then(function() {
                        return fa.tickFreeAgencyDay();
                    })
                    .then(function() {
                        return fa.tickFreeAgencyDay();
                    })
                    .then(function() {
                        return fa.tickFreeAgencyDay();
                    })
                    .then(function() {
                        return fa.tickFreeAgencyDay();
                    })
                    .then(function() {
                        return fa.tickFreeAgencyDay();
                    })
                    .then(function() {
                        return fa.tickFreeAgencyDay();
                    })
                    .then(function() {
                        return fa.tickFreeAgencyDay();
                    })
                    .then(function() {
                        return fa.tickFreeAgencyDay();
                    })
                    .then(function() {
                        return fa.tickFreeAgencyDay();
                    })
                    .then(function() {
                        return fa.tickFreeAgencyDay();
                    })
                    .then(function() {
                        return fa.tickFreeAgencyDay();
                    })
                    .then(function() {
                        return fa.tickFreeAgencyDay();
                    })
                    .then(function() {
                        return fa.tickFreeAgencyDay();
                    })
                    .then(function() {
                        return fa.tickFreeAgencyDay();
                    })
                    .then(function() {
                        return fa.tickFreeAgencyDay();
                    })
                    .then(function() {
                        return fa.tickFreeAgencyDay();
                    })
                    .then(function() {
                        return fa.tickFreeAgencyDay();
                    })
            });
        });

    });
});
