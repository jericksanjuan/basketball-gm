define(["dao", "globals", "lib/bluebird", "util/random", "util/tradeHelpers"], function(dao, g, Promise, random, th){
    "use strict";

    var exprole, expstarter, disgruntled, freespace, lesstax, tradepick, dumppick, freeforall;

    exprole = function(tx, tm1, teams) {
        console.log('Dealing expiring contracts');
        var pid, tm2, ft;

        ft = teams.filter(th.isRebuilding);
        if(ft.length === 0)
            return false;
        tm2 = th.randomTeam(ft, tm1.tid);

        return Promise.all(
            [
                dao.players.getAll({
                    ot: tx,
                    index: "tid",
                    key: tm1.tid
                }),
            ])
            .spread(function (players) {
                console.debug(tm1, tm2);

                console.log(players);
                players = players.filter(
                    th.andF(th.expThisSeason, th.atLeastFive, th.roleplayers, th.areVeterans));

                console.log(players);
                if (players.length === 0)
                    return false;
                players = players.sort(th.oldestFirst);
                players = players.slice(0,3);
                console.log('selection', players);
                pid = random.choice(players).pid;

                var output = [];
                output.push({ tid: tm1.tid, pids: [pid,], dpids:[]});
                output.push({ tid: tm2.tid, pids: [], dpids:[]});

                return Promise.try(function() {return output; });
            });

    };

    expstarter = function(tx, tm1, teams) {
        console.log('Dealing expiring contracts');
        var pid, tm2, ft;

        ft = teams.filter(th.andF(
            th.isRebuilding,
            function(o) {return o.hasSpaceForStart; }
        ));
        if (ft.length === 0) {
            ft = teams.filter(th.isRebuilding);
        }
        if (ft.length === 0) {
            return false;
        }
        tm2 = th.randomTeam(ft, tm1.tid);

        return Promise.all(
            [
                dao.players.getAll({
                    ot: tx,
                    index: "tid",
                    key: tm1.tid
                }),
            ])
            .spread(function (players) {
                players = players.filter(
                    th.andF(th.expThisSeason, th.atLeastFive,
                        th.orF(th.roleplayers, th.starters),
                        th.areVeterans, th.tradeable));

                if (players.length === 0)
                    return false;
                players = players.sort(th.oldestFirst);
                players = players.slice(0,2);
                console.log('selection', players);
                pid = random.choice(players).pid;

                var output = [];
                output.push({ tid: tm1.tid, pids: [pid,], dpids:[]});
                output.push({ tid: tm2.tid, pids: [], dpids:[]});

                return Promise.try(function() {return output; });
            });

    };

    disgruntled = function(tx, tm1, teams) {
        console.log('have to trade disgruntled star');
        var pid, tm2, ft;

        ft = teams.filter(th.andF(
            th.isRebuilding,
            function(o) {return o.hasSpaceForMax; }
        ));
        if (ft.length === 0) {
            ft = teams.filter(th.isRebuilding);
        }
        if (ft.length === 0) {
            return false;
        }
        tm2 = th.randomTeam(ft, tm1.tid);

        return Promise.all(
            [
                dao.players.getAll({
                    ot: tx,
                    index: "tid",
                    key: tm1.tid
                }),
            ])
            .spread(function (players) {
                players = players.filter(
                    th.andF(th.expThisSeason, th.stars, th.tradeable));

                if (players.length === 0)
                    return false;
                players = players.sort(th.oldestFirst);
                players = players.slice(0,2);
                console.log('selection', players);
                pid = random.choice(players).pid;

                var output = [];
                output.push({ tid: tm1.tid, pids: [pid,], dpids:[]});
                output.push({ tid: tm2.tid, pids: [], dpids:[]});

                return Promise.try(function() {return output; });
            });
    };


    freespace = function(tx, tm1, teams) {
        console.log('trading for expiring deals');
        var pid, tm2, ft, pid2;

        ft = teams.filter(function(o) {return o.hasSpaceForRole; });
        if (ft.length === 0) {
            ft = teams;
        }
        if (ft.length === 0)
            return false;

        tm2 = th.randomTeam(ft, tm1.tid);

        return Promise.all(
            [
                dao.players.getAll({
                    ot: tx,
                    index: "tid",
                    key: tm1.tid
                }),
                dao.players.getAll({
                    ot: tx,
                    index: "tid",
                    key: tm2.tid
                }),
            ])
            .spread(function (players, others) {
                players = players.filter(th.andF(
                    th.notF(th.expThisSeason),
                    th.roleplayers,
                    th.atLeastFive,
                    th.tradeable
                    )
                );

                if (players.length === 0)
                    return false;
                players = players.sort(th.costlyFirst);
                players = players.slice(0,2);
                console.log('selection', players);
                pid = random.choice(players).pid;

                others = others.filter(th.andF(
                    th.expThisSeason,
                    th.tradeable
                ));
                if (others.length === 0)
                    return false;
                others = others.sort(th.costlyFirst);
                others = others.slice(0,3);
                pid2 = random.choice(others).pid;

                var output = [];
                output.push({ tid: tm1.tid, pids: [pid,], dpids:[]});
                output.push({ tid: tm2.tid, pids: [pid2,], dpids:[]});

                return Promise.try(function() {return output; });
            });
    };

    lesstax = function(tx, tm1, teams) {
        console.log('moving assets to free lessen tax');
        var pid, tm2, ft, taxAmount;

        taxAmount = g.luxuryTax - tm1.payroll;

        ft = teams.filter(function(o) {return o.hasSpaceForRole; });
        if (ft.length === 0)
            ft = teams;
        if (ft.length === 0)
            return false;
        tm2 = th.randomTeam(ft, tm1.tid);

        return Promise.all(
            [
                dao.players.getAll({
                    ot: tx,
                    index: "tid",
                    key: tm1.tid
                }),
            ])
            .spread(function (players) {
                players = players.filter(th.andF(
                    th.notF(th.expThisSeason),
                    th.orF(th.roleplayers, th.starters),
                    th.tradeable
                    )
                );

                players = players.filter(function(o) {
                    return o.contract.amount <= taxAmount*1.25;
                });

                if (players.length === 0)
                    return false;
                players = players.sort(th.costlyFirst);
                players = players.slice(0,2);
                console.log('selection', players);
                pid = random.choice(players).pid;

                var output = [];
                output.push({ tid: tm1.tid, pids: [pid,], dpids:[]});
                output.push({ tid: tm2.tid, pids: [], dpids:[]});

                return Promise.try(function() {return output; });
            });
    };

    // contending, offer pick(s) for role players with skills
    tradepick = function(tx, tm1, teams) {
        console.log('shopping pick for player with value');
        if (teams.length === 0)
            return false;

        var tm2 = th.randomTeam(teams, tm1.tid);
        var year = g.phase <= g.PHASE.AFTER_DRAFT ? g.season : g.season + 1;

        return Promise.all([
                dao.draftPicks.getAll({
                    ot: tx,
                    index: "tid",
                    key: tm1.tid
                }),
                dao.players.getAll({
                    ot: tx,
                    index: "tid",
                    key: tm2.tid
                }),
            ])
            .spread(function(picks, players) {
                picks = picks.filter(function(o) { return o.season === year;});
                if(picks.length === 0)
                    return false;
                var dpid = random.choice(picks).dpid;

                if(players.length === 0)
                    return false;
                players = players.sort(th.highToLow);
                players = players.slice(0, 3);
                var pid = random.choice(players).pid;

                var output = [];
                output.push({ tid: tm1.tid, pids: [], dpids:[dpid,]});
                output.push({ tid: tm2.tid, pids: [pid], dpids:[]});

                return Promise.try(function() {return output; });
            })
    };

    dumppick = function(tx, tm1, teams) {
        console.log('dumping pick for future');

        if (teams.length === 0)
            return false;
        var tm2 = th.randomTeam(teams, tm1.tid);
        var year = g.phase <= g.PHASE.AFTER_DRAFT ? g.season : g.season + 1;

        return Promise.all([
                dao.draftPicks.getAll({
                    ot: tx,
                    index: "tid",
                    key: tm1.tid
                })
            ])
            .spread(function(picks) {
                picks = picks.filter(function(o) { return o.season === year;});
                if(picks.length === 0)
                    return false;
                var dpid = random.choice(picks).dpid;

                var output = [];
                output.push({ tid: tm1.tid, pids: [], dpids:[dpid,]});
                output.push({ tid: tm2.tid, pids: [], dpids:[]});

                return Promise.try(function() {return output; });
            })
    };

    freeforall = function(tx, tm1, teams) {
        console.log('Explore trades');
        var pid, tm2, ft;

        if (teams.length === 0)
            return false;
        tm2 = th.randomTeam(teams, tm1.tid);

        return Promise.all(
            [
                dao.players.getAll({
                    ot: tx,
                    index: "tid",
                    key: tm1.tid
                }),
            ])
            .spread(function (players) {
                console.debug(tm1, tm2);

                var filters;
                if (tm1.isFavorite) {
                    filters = th.roleplayers;
                } else {
                    if (tm1.isRebuilding) {
                        filters = th.orF(th.roleplayers, th.starters);
                    } else {
                        filters = th.orF(th.roleplayers, th.starters, th.stars);
                    }
                }

                players = players.filter(th.tradeable);
                players = players.filter(filters);

                if (players.length === 0)
                    return false;
                console.log('selection', players);
                pid = random.choice(players).pid;

                var mtids, mpids, mdpids;
                var otherTid, otherPid, otherDpid;

                mtids = tm1.tid;
                otherTid = tm2.tid;
                mpids = [pid, ];
                otherPid = [];
                mdpids = [];
                otherDpid = [];

                var output = [
                    { tid: mtids, pids: mpids, dpids: mdpids},
                    { tid: otherTid, pids: otherPid, dpids: otherDpid}
                ]
                console.log('BLANK', JSON.stringify(output));

                return Promise.try(function() {return output; });
            });

    };

    return {
        exprole: exprole, expstarter: expstarter, disgruntled: disgruntled, freespace: freespace,
        lesstax: lesstax, tradepick: tradepick, dumppick: dumppick, freeforall: freeforall
    };
});
