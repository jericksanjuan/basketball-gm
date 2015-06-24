/**
 * @name views.message
 * @namespace View a single message.
 */
define(["dao", "globals", "ui", "core/league", "lib/knockout", "lib/react", "util/viewHelpers"], function (dao, g, ui, league, ko, React, viewHelpers) {
    "use strict";

    function updateMessage(mid) {
//        if (updateEvents.indexOf("dbChange") >= 0 || updateEvents.indexOf("firstRun") >= 0 || vm.message.mid() !== inputs.mid) {
        var message, readThisPageview, tx;

        tx = dao.tx("messages", "readwrite");

        readThisPageview = false;

        // If mid is null, this will open the *unread* message with the highest mid
        dao.messages.iterate({
            ot: tx,
            key: mid,
            direction: "prev",
            callback: function (messageLocal, shortCircuit) {
                message = messageLocal;

                if (!message.read) {
                    shortCircuit(); // Keep looking until we find an unread one!

                    message.read = true;
                    readThisPageview = true;

                    return message;
                }
            }
        });

        return tx.complete().then(function () {
            league.updateLastDbChange();

            if (readThisPageview) {
                if (g.gameOver) {
                    ui.updateStatus("You're fired!");
                }

                return ui.updatePlayMenu(null);
            }
        }).then(function () {
            return {
                message: message
            };
        });
//        }
    }

    var CommentBox = React.createClass({
        render: function() {
            return (
                <div>
                    <h4 style={{marginTop: "23px"}}>
                        From: <span>{this.props.message.from}</span>, <span>{this.props.message.year}</span> NW
                    </h4>
                    <span dangerouslySetInnerHTML={{__html: this.props.message.text}}></span>
                    <p><a href="INBOX LINK">Return To Inbox</a></p>
                </div>
            );
        }
    });

    function get(req) {
        viewHelpers.beforeLeague(req).spread(function (updateEvents, cb) {
            var mid;

            mid = req.params.mid ? parseInt(req.params.mid, 10) : null;

            return updateMessage(mid);
        }).then(function (data) {
            React.render(
                <CommentBox message={data.message} />,
                document.getElementById('league_content')
            );
        });
    }

    function uiFirst(vm) {
        ko.computed(function () {
            ui.title("Message From " + vm.message.from());
        }).extend({throttle: 1});
    }

    return {
        get: get
    };
});