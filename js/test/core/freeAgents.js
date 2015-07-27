/**
 * @name test.core.draft
 * @namespace Tests for core.draft.
 */
define(["dao", "db", "globals", "core/league", "core/freeAgents"], function (dao, db, g, league, fa) {
    "use strict";

    describe("core/freeAgents", function () {
        before(function () {
            return db.connectMeta().then(function () {
                return league.create("Test", 20, undefined, 2015, false);
            });
        });
        after(function () {
            return league.remove(g.lid);
        });

        describe('readyTeamsFA', function() {
            it('should ready teams for FA', function() {
                return fa.readyTeamsFA()
                    .then(function(teams) {
                        console.log(teams);
                    });
            });
        });

    });
});
