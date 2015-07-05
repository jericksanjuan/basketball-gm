define(["globals"], function(g){
    "use strict";

    var notF, andF, orF, expThisSeason, highToLow, areVeterans,
        starters, stars, roleplayers, atLeastFive;

    notF = function(func) { return function(){ return !func.apply(this, arguments);};};

    andF = function() {
        var funcs = arguments;
        return function() {
            for (var i = 0; i < funcs.length; i++) {
                if(!funcs[i].apply(this, arguments))
                    return false;
            }
            return true;
        }
    };
    orF = function() {
        var funcs = arguments;
        return function() {
            for (var i = 0; i < funcs.length; i++) {
                if(funcs[i].apply(this, arguments))
                    return true;
            }
            return false;
        }
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

    highToLow = function(a, b) { return b.value - a.value; };

    return {
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
    }
});
