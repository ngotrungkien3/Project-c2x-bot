﻿const fs = require('fs');
const path = require('path');
const login = require('fca-c2x');
const { doneAnimation, errAnimation } = require('../logger/index');
const { UserInThreadData, getUser, getThread, money, getAllGroupCount, getAllUserCount } = require('./data');
const startServer = require('../dashboard/server/app');

const commandsDir = path.join(__dirname, '../scripts/commands'), eventsDir = path.join(__dirname, '../scripts/events');

const client = {
   commands: [],
   events: [],
   commandMap: new Map(),
   eventMap: new Map(),
   replyHandlers: new Map(),
   cooldowns: new Map(),
   language: new Object(),
   mqttListener: null,
   config: require('../config/config.main.json'),
   nsfw: require('../db/data/nsfw/nsfwGroups.json')
};

const langFile = fs.readFileSync(`./language/${client.config.LANGUAGE || "vi"}.lang`, { encoding: 'utf-8' })
    .split(/\r?\n|\r/);
const langData = langFile.filter(item => item.indexOf('#') !== 0 && item.trim() !== '');

for (const item of langData) {
    const getSeparator = item.indexOf('=');
    if (getSeparator === -1) continue;  
    const itemKey = item.slice(0, getSeparator).trim();
    const itemValue = item.slice(getSeparator + 1).trim();
    client.language[itemKey] = itemValue.replace(/\\n/gi, '\n'); 
}

getLang = function (...args) {
    const langText = client.language;
    if (!langText.hasOwnProperty(args[0])) {
        return;
    }

    let text = langText[args[0]];

    for (let i = 1; i < args.length; i++) {
        const regEx = new RegExp(`\\$${i}`, 'g');
        text = text.replace(regEx, args[i]);
    }

    return text;
};

async function startBot() {
    try {
        login(
            { appState: JSON.parse(fs.readFileSync("appstate.json", "utf8")) },
            {
                listenEvents: true,
                autoMarkDelivery: false,
                updatePresence: true,
                logLevel: 'silent'
            },
            async (err, api) => {
                doneAnimation(getLang('currentlyLogged'));
                if (err) {
                errAnimation(getLang('loginError'));
                return console.error(err);
                }
  
                const userId = api.getCurrentUserID();
                const user = await api.getUserInfo([userId]);
                const userName = user[userId]?.name || null;
                doneAnimation(getLang('loginSuccess', userName, userId));
                if (client.config.RUN_SERVER_UPTIME) {
                    startServer(getLang);
                }
                doneAnimation(getLang('pluginLoading'));
                doneAnimation(getLang('loadThreadDataSuccess', await getAllGroupCount()));
                doneAnimation(getLang('loadUserDataSuccess', await getAllUserCount()));    
                client.commands = loadCommands(api);
                client.events = loadEvents(api); 
                startmqttListener(api);
            }
        );
    } catch (err) {
        console.error(err);
        setTimeout(startBot, 5000); 
    }
}

function reloadCommandsAndEvents(api) {
    clearCommandsAndEvents();
    client.commands = loadCommands(api);
    client.events = loadEvents(api);
}

function loadCommands(api) {
    const commandFiles = fs.readdirSync(commandsDir).filter(file => file.endsWith('.js'));
    const commands = commandFiles.map(file => {
        const commandModule = require(path.join(commandsDir, file));
        if (commandModule && commandModule.name) {
             client.commandMap.set(commandModule.name.toLowerCase(), commandModule);
            
            if (commandModule.alias && Array.isArray(commandModule.alias)) {
                commandModule.alias.forEach(aliases => {
                    client.commandMap.set(aliases.toLowerCase(), commandModule);
                });
            }
            
            if (commandModule.onLoad) {
                commandModule.onLoad({ client, api });
            }
            return commandModule;
        } else {
            console.error(getLang('reloadCammandError', file));
            return null;
        }
    }).filter(command => command !== null);
    doneAnimation(getLang('reloadCommand', commands.length));
    return commands;
}


function loadEvents(api) {
    const eventFiles = fs.readdirSync(eventsDir).filter(file => file.endsWith('.js'));
    const events = eventFiles.map(file => {
        const eventModule = require(path.join(eventsDir, file));
        if (eventModule && eventModule.name) {
            client.eventMap.set(eventModule.name.toLowerCase(), eventModule);
            if (eventModule.onLoad) {
                eventModule.onLoad({ client, api });
            }
            return eventModule;
        } else {
            console.error(getLang('reloadEventError', file));
            return null;
        }
    }).filter(event => event !== null);
    doneAnimation(getLang('reloadEvent', events.length));
    return events;
}

function handleMQTTEvents(api) {
    client.mqttListener = api.listenMqtt(async (err, message) => {
        if (err) {
            console.error(err);
            return;
        }

        if (message.type == "message" || message.type == "message_reply") {
            message.user = (await api.getUserInfo(message.senderID))[message.senderID];
            message.thread = await api.getThreadInfo(message.threadID);
            message.react = (content) => {
                return new Promise((resolve, reject) => {
                    api.setMessageReaction(content, message.messageID, (err, message) => {
                        if (err) {
                            reject(err);
                        } else {
                            resolve(message);
                        }
                    }, () => {}, true);
                });
            };
            message.reply = (content, targetID) => {
                return new Promise((resolve, reject) => {
                    api.sendMessage(content, targetID, (err, message) => {
                        if (err) {
                            reject(err);
                        } else {
                            resolve(message);
                        }
                    }, message.messageID);
                });
            };
            message.send = (content, targetID) => {
                return new Promise((resolve, reject) => {
                    api.sendMessage(content, targetID, (err, message) => {
                        if (err) {
                            reject(err);
                        } else {
                            resolve(message);
                        }
                    });
                });
            };
        }

        UserInThreadData(message);
   
        try {

            for (const module of [...client.commands,...client.events]) {
                try {
                  if (module.onMessage) {
                    await module.onMessage({ client, api, message, user: getUser, thread: getThread, money });
                  }
                } catch (err) {
                  console.error(err);
                }
              }

            if (!message.body) {
                return;
            }

            let command = '';
            let args = [];
            let hasPrefix = false;

            if (message.body.startsWith(client.config.PREFIX)) {
                hasPrefix = true;
                args = message.body.slice(client.config.PREFIX.length).trim().split(' ');
                command = args.shift().toLowerCase();
            } else {
                command = message.body.trim().split(' ')[0].toLowerCase();
                args = message.body.trim().split(' ').slice(1);
            }

            const commandModule = client.commandMap.get(command);
              if (commandModule) {
                if (!commandModule.nopre && !hasPrefix) {
                    return;
                }
                if (commandModule.wait) {
                    const userId = message.senderID;
                    const commandName = commandModule.name;
                
                    if (!client.cooldowns.has(userId)) {
                        client.cooldowns.set(userId, new Map());
                    }
                    
                    const userCooldowns = client.cooldowns.get(userId);
                
                    if (userCooldowns.has(commandName)) {
                        const expirationTime = userCooldowns.get(commandName);
                        const currentTime = Date.now();
                        
                        if (currentTime < expirationTime) {
                            if (!userCooldowns.get(`${commandName}_notified`)) {
                                const timeLeft = (expirationTime - currentTime) / 1000;
                                api.sendMessage(getLang('commandWait', commandName, timeLeft.toFixed(1)), message.threadID);
                                userCooldowns.set(`${commandName}_notified`, true); 
                            }
                            return;
                        }
                    }
                
                    const waitTime = commandModule.wait * 1000;
                    const expirationTime = Date.now() + waitTime;
                    userCooldowns.set(commandName, expirationTime);
                    userCooldowns.delete(`${commandName}_notified`); 
                }            
                if (commandModule.category === "nsfw") {
                    if (!client.nsfw.includes(message.threadID)) {
                      api.sendMessage(getLang('commandNsfw'), message.threadID);
                      return;
                    }
                  }
                if (commandModule.admin && !client.config.UID_ADMIN.includes(message.senderID)) {
                    api.sendMessage(getLang('commandAdmin'), message.threadID);
                    return;
                  }
                  let getText;

                  if (commandModule.lang && typeof commandModule.lang === 'object' && commandModule.lang.hasOwnProperty(client.config.LANGUAGE)) {
                   getText = (...values) => {
                  const language = commandModule.lang[client.config.LANGUAGE];
                  const key = values[0];
                  let text = language[key] || '';

                  for (let i = 1; i < values.length; i++) {
                  const regEx = new RegExp(`\\$${i}`, 'g');
                  text = text.replace(regEx, values[i]);
                  }

                  return text;
                  };
             } else {
                 getText = () => {};
            }
                await commandModule.onCall({ client, api, message, args, user: getUser, thread: getThread, getAllUserCount, getAllGroupCount, money, reload: reloadCommandsAndEvents, getText });
            } else {
                if (hasPrefix) {
                    const fallbackCommand = client.commandMap.get('\n');
                    if (fallbackCommand) {
                        await fallbackCommand.onCall({ api, message });
                    }
                }
            }
        } catch (err) {
            console.error(err);
        }
    });
}

function startmqttListener(api) {
    if (client.mqttListener) {
        client.mqttListener.stopListening();
    }
    handleMQTTEvents(api);
    setInterval(() => {
        doneAnimation(getLang('refreshMqtt'));
        if (client.mqttListener) {
            client.mqttListener.stopListening();
        }
        handleMQTTEvents(api);
    }, 2 * 60 * 60 * 1000); 
}

function clearCommandsAndEvents() {
    fs.readdirSync(commandsDir).forEach(file => {
        if (file.endsWith('.js')) {
            const commandPath = path.join(commandsDir, file);
            delete require.cache[require.resolve(commandPath)];
        }
    });

    fs.readdirSync(eventsDir).forEach(file => {
        if (file.endsWith('.js')) {
            const eventPath = path.join(eventsDir, file);
            delete require.cache[require.resolve(eventPath)];
        }
    });

    client.commandMap.clear();
    client.eventMap.clear();
    client.cooldowns.clear();
}

startBot();
