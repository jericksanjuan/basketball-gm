/**
 * @name views.playoffs
 * @namespace Show current or archived playoffs, or projected matchups for an in-progress season.
 */
define(["dao", "globals", "ui", "core/team", "lib/knockout", "util/bbgmView", "util/helpers", "views/components"], function (dao, g, ui, team, ko, bbgmView, helpers, components) {
    "use strict";

    function get(req) {
        return {
            season: helpers.validateSeason(req.params.season)
        };
    }

    function updatePlayoffs(inputs, updateEvents, vm) {
        if (updateEvents.indexOf("dbChange") >= 0 || updateEvents.indexOf("firstRun") >= 0 || inputs.season !== vm.season() || (inputs.season === g.season && updateEvents.indexOf("gameSim") >= 0)) {
            // If in the current season and before playoffs started, display projected matchups
            if (inputs.season === g.season && g.phase < g.PHASE.PLAYOFFS) {
                return team.filter({
                    attrs: ["tid", "cid", "abbrev", "name"],
                    seasonAttrs: ["winp"],
                    season: inputs.season,
                    sortBy: helpers.getPlayoffSorting()
                }).then(function (teams) {
                    var cid, i, series, teamsConf;

                    series = [[], [], [], []];  // First round, second round, third round, fourth round
                    for (cid = 0; cid < 2; cid++) {
                        teamsConf = [];
                        for (i = 0; i < teams.length; i++) {
                            if (teams[i].cid === cid) {
                                teamsConf.push(teams[i]);
                            }
                        }
                        series[0][cid * 4] = {home: teamsConf[0], away: teamsConf[7]};
                        series[0][cid * 4].home.seed = 1;
                        series[0][cid * 4].away.seed = 8;
                        series[0][1 + cid * 4] = {home: teamsConf[1], away: teamsConf[6]};
                        series[0][1 + cid * 4].home.seed = 2;
                        series[0][1 + cid * 4].away.seed = 7;
                        series[0][2 + cid * 4] = {home: teamsConf[2], away: teamsConf[5]};
                        series[0][2 + cid * 4].home.seed = 3;
                        series[0][2 + cid * 4].away.seed = 6;
                        series[0][3 + cid * 4] = {home: teamsConf[3], away: teamsConf[4]};
                        series[0][3 + cid * 4].home.seed = 4;
                        series[0][3 + cid * 4].away.seed = 5;
                    }

                    return {
                        finalMatchups: false,
                        series: series,
                        season: inputs.season
                    };
                });
            }

            // Display the current or archived playoffs
            return dao.playoffSeries.get({key: inputs.season}).then(function (playoffSeries) {
                var series;

                series = playoffSeries.series;

                return {
                    finalMatchups: true,
                    series: series,
                    season: inputs.season
                };
            });
        }
    }

    function uiFirst(vm) {
        ko.computed(function () {
            ui.title("Playoffs - " + vm.season());
        }).extend({throttle: 1});
    }

    function uiEvery(updateEvents, vm) {
        components.dropdown("playoffs-dropdown", ["seasons"], [vm.season()], updateEvents);
    }

    return bbgmView.init({
        id: "playoffs",
        get: get,
        runBefore: [updatePlayoffs],
        uiFirst: uiFirst,
        uiEvery: uiEvery
    });
});
