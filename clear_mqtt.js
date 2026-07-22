/* MQTT one-shot v2.9: sem reconexão automática */
const mqtt = require('mqtt');

const brokers = [
  'wss://broker.emqx.io:443/mqtt',
  'wss://broker.hivemq.com:8000/mqtt',
  'wss://broker.emqx.io:8084/mqtt'
];

const topicsToClear = [
  'apexscorpio/streamtools/v1/cfg/chat_message',
  'apexscorpio/streamtools/v1/cfg/new_event',
  'apexscorpio/streamtools/v1/cfg/clear_chat',
  'apexscorpio/streamtools/v1/cfg/clear_events',
  'apexscorpio/streamtools/v1/cfg/clear_alerts',
  'apexscorpio/streamtools/v1/cfg/status_update',
  'apexscorpio/streamtools/v1/cfg/clear_viewers',
  'apexscorpio/streamtools/v1/cfg/trigger_alert'
];

brokers.slice(0,1).forEach(url => {
  console.log(`Connecting to ${url}...`);
  const client = mqtt.connect(url,{reconnectPeriod:0,
    clientId: 'scorpio_cleaner_' + Math.random().toString(16).substring(2, 8),
    connectTimeout: 4000
  });

  client.on('connect', () => {
    console.log(`Connected to ${url}. Clearing retained topics...`);
    let cleared = 0;
    topicsToClear.forEach(topic => {
      client.publish(topic, '', { retain: true, qos: 1 }, (err) => {
        if (err) console.error(`Failed to clear ${topic} on ${url}:`, err);
        else console.log(`Cleared ${topic} on ${url}`);
        
        cleared++;
        if (cleared === topicsToClear.length) {
          console.log(`Finished clearing on ${url}. Disconnecting.`);
          client.end();
        }
      });
    });
  });

  client.on('error', (err) => {
    console.error(`Error on ${url}:`, err);
  });
});
