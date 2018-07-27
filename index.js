const request    = require('request');
const express    = require('express');
const bodyParser = require('body-parser');
const parser     = require('./src/parser');
const db         = require('./src/db');
const Chart      = require('chartjs-node');

const app = express();

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({extended: true}));
app.set('port', (process.env.PORT || 9001));
app.get('/', (req, res) => res.send('It works!'));
app.get('/chart/:poll_id/poll.png', (req, res) => {
  console.log("chart::poll_id", req.params.poll_id);

  const id   = parseInt(req.params.poll_id, 10)
  const poll = Number.isNaN()
    ? null
    : db.get(id);

  if (poll !== null) {
    console.log("chart::poll::success", poll);

    const chart = new Chart(600, 600);

    chart.drawChart({
      type: 'horizontalBar',
      data: {
        labels: poll.responses.map(x => x.text),
        datasets: [
          {
            label: "PollChart",
            data: poll.responses.map(x => x.votes)
          }
        ]
      },
      options: {
        scales: {
          xAxes: [
            {
              gridLines: {
                display: false
              }
            }
          ],
          yAxes: [
            {
              gridLines: {
                display: false
              },
              ticks: {
                beginAtZero: true
              }
            }
          ]
        }
      }
    }).then(() => chart.getImageBuffer('image/png'))
      .then(buffer => {
        console.log("chart::generated");

        res.status(200);
        res.contentType('image/png');
        res.end(buffer, 'binary');
      })
      .then(() => chart.destroy())
      .catch(e => {
        console.error(e);
        chart.destroy();
        res.status(500).end();
      });
  }
  else {
    res.status(404).end();
  }
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
      const pollId   = parseInt(match[1], 10);
      const poll     = db.get(pollId);
      const actionId = parseInt(data.actions[0].name, 10);
      const response =  poll.responses.find(x => x.name === actionId);

      response.votes += 1;
      console.log('action::response', response);

      sendMessageToSlackResponseURL(data.response_url, {
        "text": data.user.name + " clicked: " + response.text,
        "replace_original": true,
        "attachments": [
          {
            "fallback": "Poll result fallback",
            "title": "Poll result",
            "image_url": `https://mighty-bayou-64992.herokuapp.com/chart/${pollId}/poll.png`,
          }
        ]
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
