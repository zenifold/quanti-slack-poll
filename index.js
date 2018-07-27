const request    = require('request');
const express    = require('express');
const bodyParser = require('body-parser');
const parser     = require('./src/parser');
const db         = require('./src/db');
const Chart      = require('chartjs-node');

const chart = new Chart(600, 600);
const app = express();

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({extended: true}));
app.set('port', (process.env.PORT || 9001));
app.get('/', (req, res) => res.send('It works!'));
app.get('/chart/:poll_id', (req, res) => {
  const poll = db.get(parseInt(req.params.poll_id, 10));

  console.log(poll);

  chart.drawChart({
      type: 'bar',
      data: poll.responses.map(x => x.votes)
  })
  .then(data => {
    res.contentType('image/jpeg');
    res.end(data.getImageBuffer('image/png'), 'binary');
  });
});

app.post('/post', ({body: {token, user_id, text, response_url}}, res) => {
  res.status(200).end();

  if (token !== process.env.SLACK_APP_TOKEN) {
    console.error('Invalid token', token);
    res.status(403).end('Access forbidden');
  }
  else {
    const values = parser.parse(text);

    if (3 > values.length) {
      res.status(400).end('Not enough values found');
    }
    else {
      const poll = db.generate(user_id, values);

      sendMessageToSlackResponseURL(response_url, {
        "text": "This is your first interactive message",
        "attachments": [
          {
            "text": poll.question,
            "fallback": "Shame on you...",
            "callback_id": `askia_poll_${poll.id}`,
            "color": "#3AA3E3",
            "attachment_type": "default",
            "actions": poll.responses
          }
        ]
      });
    }
  }
});

app.post(
  '/actions',
  bodyParser.urlencoded({extended: false}),
  ({body: {payload, response_url}}, res) => {
    res.status(200).end();

    const data   = JSON.parse(payload);
    const match  = /askia_poll_([\d+])/.exec(data.callback_id);

    console.log('action::callback_id', data.callback_id);

    if (match) {
      const pollId = parseInt(match[1], 10);

      console.log('action::poll_id', pollId);

      sendMessageToSlackResponseURL(data.response_url, {
        "text": data.user.name + " clicked: " + data.actions[0].name,
        "image_url": `https://mighty-bayou-64992.herokuapp.com/chart/${pollId}`,
        "replace_original": true
      });
    }
  }
)

app.listen(app.get('port'), () => {
  console.log('Node app is running on port', app.get('port'))
});

const postOptions = {
  method: 'POST',
  headers: {'Content-type': 'application/json'},
};

const sendMessageToSlackResponseURL = (uri, json) => {
  request({...postOptions, uri, json}, (error, response, body) => {
    if (error){

    }
  })
}
