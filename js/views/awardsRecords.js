/**
 * @name views.schedule
 * @namespace Show current schedule for user's team.
 */
define(["globals", "ui", "core/team", "lib/jquery", "lib/knockout", "lib/underscore", "util/bbgmView", "util/helpers", "util/viewHelpers", "views/components", "dao", "lib/bluebird"], function (g, ui, team, $, ko, _, bbgmView, helpers, viewHelpers, components, dao, Promise) {
    "use strict";

    var awardOptions, mapping, optionsTmp;

    function get(req) {
        return {
            awardType: req.params.awardType || 'champion'
        };
    }

    function InitViewModel() {
        this.awardType = ko.observable();
        this.playerCount = ko.observable();
        this.awardTypeVal = ko.observable();
    }

    mapping = {
        awardsRecords: {
            create: function (options) {
                return options.data;
            }
        }
    };

    optionsTmp = [{
            val: "Won Championship",
            key: "champion"
        }, {
            val: "Most Valuable Player",
            key: "mvp"
        }, {
            val: "Finals MVP",
            key: "finals_mvp"
        }, {
            val: "Defensive Player of the Year",
            key: "dpoy"
        }, {
            val: "Sixth Man of the Year",
            key: "smoy"
        }, {
            val: "Rookie of the Year",
            key: "roy"
        }, {
            val: "First Team All-League",
            key: "first_team"
        }, {
            val: "Second Team All-League",
            key: "second_team"
        }, {
            val: "Third Team All-League",
            key: "third_team"
        }, {
            val: "First Team All-Defensive",
            key: "first_def"
        }, {
            val: "Second Team All-Defensive",
            key: "second_def"
        }, {
            val: "Third Team All-Defensive",
            key: "third_def"
        }, {
            val: "All-League",
            key: "all_league"
        }, {
            val: "All-Defensive",
            key: "all_def"
        }

    ];

    awardOptions = {};
    optionsTmp.map(function (o) {
        awardOptions[o.key] = o.val;
    });

    function getPlayerLink(p) {
        return '<a href="' + helpers.leagueUrl(["player", p.pid]) + '">' + p.name + '</a>';
    }

    function getPlayerAwards(p, awardType) {
        var aType, awards, filter, formatYear, getTeam, last, years;
        aType = awardOptions[awardType];
        if (awardType === 'all_league') {
            filter = function (a) {
                var o = awardOptions;
                return a.type === o.first_team || a.type === o.second_team || a.type === o.third_team;
            };
        } else if (awardType === 'all_def') {
            filter = function (a) {
                var o = awardOptions;
                return a.type === o.first_def || a.type === o.second_def || a.type === o.third_def;
            };
        } else {
            filter = function (a) {
                return a.type === aType;
            };
        }

        getTeam = function(season) {
            var stats, tid;
            stats = _.filter(p.stats, function(s) {
                return s.season === season;
            });
            tid = _.last(stats);
            if (tid) {
                tid = tid.tid;
                return g.teamAbbrevsCache[tid];
            } else {
                return '-';
            }
        }

        formatYear = function(year) {
            var keys = _.keys(year),
                sout;
            sout = _.map(keys, function(k) {
                var s,
                    years = _.pluck(year[k], 'season').join(', ');
                s = k + ' <small>(' + years + ')</small>';
                return s;
            });
            return sout.join(', ');
        }

        awards = p.awards.filter(filter);
        years = awards.map(function (a) {
            return {team: getTeam(a.season), season: a.season};
        });
        last = _.max(_.pluck(years, 'season'));
        years = formatYear(_.groupBy(years, 'team'));
        return {
            player: getPlayerLink(p),
            count: awards.length,
            countText: awards.length.toString(),
            years: years,
            lastYear: last.toString(),
            retired: (p.retiredYear) ? "yes" : "no",
            hof: (p.hof) ? "yes" : "no"
        };
    }

    function updateAwardsRecords(inputs, updateEvents, vm) {
        if (updateEvents.indexOf("dbChange") >= 0 || updateEvents.indexOf("firstRun") >= 0 || inputs.awardType !== vm.awardType) {
            return Promise.all([
                dao.players.getAll({
                    statsSeasons: "all"
                })
            ]).spread(function (players) {
                var awardsRecords, i;

                awardsRecords = [];
                players = players.filter(function (p) {
                    return p.awards.length > 0;
                });
                for (i = 0; i < players.length; i++) {
                    awardsRecords.push(getPlayerAwards(players[i], inputs.awardType));
                }
                awardsRecords = awardsRecords.filter(function (o) {
                    return o.count > 0;
                });

                return {
                    awardsRecords: awardsRecords,
                    playerCount: awardsRecords.length,
                    awardTypeVal: awardOptions[inputs.awardType],
                    awardType: inputs.awardType
                };
            });
        }
    }

    function uiFirst(vm) {
        ko.computed(function () {
            ui.title("Awards Records");
        }).extend({
            throttle: 1
        });

        ko.computed(function () {
            ui.datatableSinglePage($("#awards-records"), 0, _.map(vm.awardsRecords(), function (p) {
                return [p.player, p.countText, p.years, p.lastYear, p.retired, p.hof];
            }), {
                paging: true,
                searching: true,
                pagingType: "bootstrap"
            });
        }).extend({
            throttle: 1
        });

        ui.tableClickableRows($("#awards-records"));
    }

    function uiEvery(updateEvents, vm) {
        components.dropdown("awards-records-dropdown", ["awardType"], [vm.awardType()], updateEvents);
    }

    return bbgmView.init({
        id: "awardsRecords",
        get: get,
        InitViewModel: InitViewModel,
        mapping: mapping,
        runBefore: [updateAwardsRecords],
        uiFirst: uiFirst,
        uiEvery: uiEvery
    });
});
