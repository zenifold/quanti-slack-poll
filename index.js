/* eslint-disable camelcase */
const {WebClient} = require("@slack/web-api");
const express     = require("express");
const bodyParser  = require("body-parser");
const https       = require("https");
const path        = require("path");
const fs          = require("fs");
const slackify    = require("slackify-markdown");
const pollModel   = require("./lib/model/poll.js");
const polls       = require("./lib/store/poll.js");
const teams       = require("./lib/store/team.js");
const view        = require("./lib/view/poll.js");
const errView     = require("./lib/view/error.js");
const vote        = require("./lib/action/vote.js");
const cmd         = require("./lib/cmd.js");
const {
  pollIdFrom,
  isDeleteAction,
  responseFromAction,
  tap, guard, log
} = require("./lib/util.js");

/* Slack API client initialization */
const web = new WebClient();

/* Server base settings */
const app = express();

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({extended: true}));
app.set('port', process.env.PORT);

/* SSL credentials */
const credentials = {
  "key": fs.readFileSync(process.env.SSL_KEY),
  "cert": fs.readFileSync(process.env.SSL_CERT),
  "ca": fs.readFileSync(process.env.SSL_CHAIN)
};

/* Help text used as response when user type /askia --help */
const help = slackify(fs.readFileSync(
  path.resolve(__dirname, "./Help.md"),
  {encoding: "utf8"}
));

/** Handles slack authentication with app redirection pages. */
app.get("/slack/auth/redirect", (req, res) => {
  if (!process.env.SLACK_CLIENT_ID || !process.env.SLACK_CLIENT_SECRET) {
    res.status(500).send("Missing CLIENT_ID or CLIENT_SECRET");
  }
  else {
    web.oauth
      .access({
        "code": req.query.code,
        "client_id": process.env.SLACK_CLIENT_ID,
        "client_secret": process.env.SLACK_CLIENT_SECRET
      })
      .then(handleResponse)
      .then(resp => teams.create({
        "teamId": resp.team_id,
        "token": resp.access_token
      }))
      .then(_ => res.status(200).end("Success!"))
      .catch(e => res.status(200).end(`Slack error: ${e.message}`));
  }
});

/**
 * Handles the command line input. The commands are received from
 * the Slack API and response are also returns to the Slack API.
 */
app.post("/post", (req, res) => {
  const {body: {token, user_id, team_id, channel_id, text}} = req;
  if (token !== process.env.SLACK_APP_TOKEN) {
    res.status(403).end("Access forbidden");
  }
  else {
    Promise
      .resolve({token, user_id, channel_id, text})
      .then(tap(log("/post:request.body")))
      .then(_ => cmd.parse(text))
      .then(tap(log("/post:cmd.parse()")))
      .then(argv => argv.help
        ? showHelp(team_id, user_id, channel_id)
        : showPoll(team_id, user_id, channel_id, argv)
      )
      .then(_ => res.status(200).end())
      .catch(sendError(res, channel_id, user_id, team_id));
  }
});

/**
 * Handles user actions on polls. These actions are received from the
 * Slack API and responses are alse returned to the Slack API.
 */
app.post("/actions", bodyParser.urlencoded({extended: false}), (req, res) => {
  const {body: {payload}} = req;
  const {actions: [action], callback_id, team, user, channel} =
    JSON.parse(payload);
  return Promise
    .resolve(callback_id)
    .then(tap(log("/action:request.body.callback_id")))
    .then(pollIdFrom)
    .then(tap(log("/action:pollIdFrom()")))
    .then(id => polls.get(id))
    .then(tap(log("/action:polls.get()")))
    .then(poll => isDeleteAction(action)
      ? deletePoll({team, user, poll})
      : votePoll({action, team, user, poll})
    )
    .then(_ => res.status(200).end())
    .catch(sendError(res, channel.id, user.id, team.id));
});

const deletePoll = data => Promise
  .resolve(data)
  .then(guard(
    ({user, poll}) => user.id === poll.ownerId,
    new Error("Only the poll creator is able to remove it")
  ))
  .then(({team, poll}) => Promise.all([
    polls
      .remove(poll._id)
      .then(tap(log("/deletePoll:polls.remove()"))),
    teams
      .get(team.id)
      .then(tap(log("/deletePoll:teams.get()")))
      .then(team => ({
        token: team.token,
        ts: poll.messageTs,
        channel: poll.channelId
      }))
      .then(tap(log("/deletePoll:message")))
      .then(web.chat.delete)
      .then(tap(log("/deletePoll:web.chat.delete()")))
      .then(handleResponse)
  ]));

const votePoll = ({action, user, poll, team}) =>
  responseFromAction(action, poll)
    .then(tap(log("/votePoll:responseFromAction()")))
    .then(response => vote.dispatch(user, poll, response))
    .then(tap(log("/votePoll:vote.dispatch()")))
    .then(changes => polls.update(poll._id, changes))
    .then(tap(log("/votePoll:polls.update()")))
    .then(poll => view.create(poll))
    .then(tap(log("/votePoll:view.create()")))
    .then(pollView => teams
      .get(team.id)
      .then(tap(log("/votePoll:teams.get()")))
      .then(team => ({
        ...pollView,
        token: team.token
      }))
      .then(tap(log("/votePoll:message")))
    )
    .then(web.chat.update)
    .then(tap(log("/votePoll:web.chat.update()")))
    .then(handleResponse);

/* Start the server on specified port */
const server = https.createServer(credentials, app);
server.listen(app.get("port"));

/* Show help message */
const showHelp = (teamId, userId, channelId) => teams
  .get(teamId)
  .then(tap(log("/showHelp:teams.get()")))
  .then(team => team ? team.token : null)
  .then(tap(log("/showHelp:team.token")))
  .then(token => web.chat.postEphemeral({
    channel: channelId,
    user: userId,
    text: help,
    token
  }));

/** Show poll message */
const showPoll = (team_id, user_id, channel_id, argv) => Promise
  .resolve(pollModel.from(user_id, channel_id, argv))
  .then(tap(log("/showPoll:poll.from()")))
  .then(polls.create)
  .then(tap(log("/showPoll:polls.create()")))
  .then(poll => teams
    .get(team_id)
    .then(tap(log("/showPoll:teams.get()")))
    .then(team => ({...view.create(poll), token: team.token}))
    .then(tap(log("/showPoll:message")))
    .then(web.chat.postMessage)
    .then(tap(log("/showPoll:web.chat.postMessage()")))
    .then(handleResponse)
    .then(tap(log("/showPoll:handleResponse()")))
    .then(msg => polls.update(poll._id, {"messageTs": msg.ts}))
    .then(tap(log("/showPoll:polls.update()")))
  );

/**
 * Sends an error message to the Slack client.
 */
const sendError = (res, channel, user, teamId) => err => teams
  .get(teamId)
  .then(tap(_ => console.log(err)))
  .then(tap(log("/sendError:teams.get()")))
  .then(({token}) => errView.dispatch(err, {channel, user, token}))
  .then(tap(log("/sendError:errView.dispatch()")))
  .then(web.chat.postEphemeral)
  .then(tap(log("/sendError:web.chat.postEphemeral()")))
  .then(_ => res.status(200).end())
  .catch(e => (console.error(e), res.status(400).end(e.message)));

/**
 * Handles a slack response object. The response is rejected if the Slack API
 * returns `ok` to `false`.
 *
 * @param {SlackRequestResponse} response
 * The slack request response to check.
 *
 * @returns {Promise<SlackRequestResponse>}
 * Returns the slack request response.
 */
const handleResponse = response =>
  new Promise((resolve, reject) => response.ok
    ? resolve(response)
    : reject(new Error(response.error || "An error occurs on Slack API"))
  );
