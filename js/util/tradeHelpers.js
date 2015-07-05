define(["globals", "util/random"], function(g, random){
    "use strict";

    var randomTeam, notF, andF, orF, expThisSeason, highToLow, areVeterans,
        starters, stars, roleplayers, atLeastFive, pids, dpids, tids,
        getWs, getWLs, sumf;

    randomTeam = function(teams, ban) {
        var selected = random.choice(teams);
        if(selected.tid === g.userTid || selected.tid === ban) {
            return randomTeam();
        }
        return selected;
    };

    // filter
    notF = function(func) { return function(){ return !func.apply(this, arguments);};};

    andF = function() {
        var funcs = arguments;
        return function() {
            for (var i = 0; i < funcs.length; i++) {
                if(!funcs[i].apply(this, arguments))
                    return false;
            }
            return true;
        };
    };
    orF = function() {
        var funcs = arguments;
        return function() {
            for (var i = 0; i < funcs.length; i++) {
                if(funcs[i].apply(this, arguments))
                    return true;
            }
            return false;
        };
    };

    expThisSeason = function(o) { return o.contract.exp === g.season; };

    atLeastFive = function(o) { return o.contract.amount > 5000; };

    areVeterans = function(o) { return g.season - o.born.year >= 28; };

    roleplayers = function(o) {
        return o.contract.amount < 0.5*g.maxContract && o.contract.amount > g.minContract;
    };

    starters = function(o) {
        return o.contract.amount >= 0.5*g.maxContract && o.contract.amount < 0.9*g.maxContract;
    };

    stars = function(o) {
        return o.contract.amount >= 0.9*g.maxContract;
    };

    // sort
    highToLow = function(a, b) { return b.value - a.value; };

    // map
    pids = function(o) { return o.pid; };
    dpids = function(o) { return o.dpid; };
    tids = function(o) { return o.tid; };
    getWs = function(o) { return o.won; };
    getWLs = function(o) { return o.won + o.lost; };

    // reduce
    sumf = function(a, b) { return a + b };

    return {
        randomTeam, randomTeam,
        notF: notF,
        andF: andF,
        orF: orF,
        expThisSeason: expThisSeason,
        highToLow: highToLow,
        areVeterans: areVeterans,
        starters: starters,
        stars: stars,
        roleplayers: roleplayers,
        atLeastFive: atLeastFive,
        pids: pids,
        dpids: dpids,
        tids: tids,
        getWs: getWs,
        getWLs: getWLs,
        sumf: sumf
    };
});
