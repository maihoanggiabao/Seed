const { workerData, parentPort } = require('worker_threads');
const { HttpsProxyAgent } = require('https-proxy-agent');
const axios = require('axios');
const { DateTime } = require('luxon');
const colors = require('colors');
const querystring = require('querystring');
const crypto = require('crypto');

const MINUTES = 60;
const HOURS = 60 * MINUTES;

const waitTimeDefault = {
    "upgrade-level": {
        0: 1 * HOURS,
        1: 2 * HOURS,
        2: 3 * HOURS,
        3: 4 * HOURS,
        4: 6 * HOURS,
        5: 12 * HOURS
    }
};

// URLs for various API endpoints
const baseUrl = 'https://elb.seeddao.org/api/v1';
const loginUrl = `${baseUrl}/profile`;
const balanceUrl = `${baseUrl}/profile/balance`;
const claimUrl = `${baseUrl}/seed/claim`;
const wormsUrl = `${baseUrl}/worms`;
const checkInventoryUrl = `${baseUrl}/worms/me`;
const sellWormUrl = `${baseUrl}/worms/exchange`;
const catchWormUrl = `${baseUrl}/worms/catch`;
const dailyBonusUrl = `${baseUrl}/login-bonuses`;

const word = {
    balance: `[ BALANCE ]`.inverse.bold.yellow,
    daily: `[  DAILY  ]`.inverse.cyan.bold,
    claim: `[  CLAIM  ]`.inverse.blue.bold,
    worm: `[  WORM   ]`.red.inverse.bold,
    waiting: `[ WAITING ]`.green.inverse.bold,
};

const formatLog = (action, balance) => {
    const actionFormatted = word[action];
    const balancePart = `${word.balance} : ${balance}`.padEnd(55);
    return `${balancePart}  | ${actionFormatted} : `;
};

class SEED {
    constructor(queryId, proxy) {
        this.queryId = queryId;
        this.proxy = proxy;
        this.balance = 0;
        this.agent = new HttpsProxyAgent(proxy);
        this.lastTimeClaim = DateTime.now();
        this.waitTime = 0;
        this.upgradeLevel = 1;
    }

    headers() {
        return {
            'Content-Type': 'application/json',
            'Telegram-Data': this.queryId,
            'User-Agent': 'Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
            'Accept': 'application/json, text/plain, */*',
            'Accept-Encoding': 'gzip, deflate, br, zstd',
            'Accept-Language': 'zh-CN,zh;q=0.9',
            'Origin': 'https://cf.seeddao.org',
            'Priority': 'u=1, i',
            'Referer': 'https://cf.seeddao.org/',
            'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
            'Sec-Ch-Ua-Mobile': '?1',
            'Sec-Ch-Ua-Platform': '"Android"',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-site'
        };
    }

    async delay(s) {
        return new Promise(resolve => setTimeout(resolve, s * 1000));
    }

    getCurrentLevel(upgrades, upgradeType) {
        let maxLevel = 0;
        for (const upgrade of upgrades) {
            if (upgrade.upgrade_type === upgradeType) {
                maxLevel = Math.max(maxLevel, upgrade.upgrade_level);
            }
        }
        return maxLevel;
    }

    updateWaitTime() {
        const timeDif = DateTime.now().diff(this.lastTimeClaim).as("seconds");
        const waitTime = waitTimeDefault["upgrade-level"][this.upgradeLevel];

        if (timeDif < waitTime) {
            this.waitTime = (waitTime - timeDif - 20 * MINUTES);
        } else {
            this.waitTime = waitTime - 20 * MINUTES;
        }
    }

    async claimDailyBonus(userName) {
        try {
            parentPort.postMessage(`${formatLog('daily', this.balance)} Claiming daily bonus...`);
            const response = await axios.post(dailyBonusUrl, {}, {
                headers: this.headers(),
                httpsAgent: this.agent
            });
            parentPort.postMessage(`${formatLog('daily', this.balance)} Response from daily bonus API: ${JSON.stringify(response.data)}`);

            if (response.data && response.data.data && response.data.data.amount) {
                parentPort.postMessage(`${formatLog('daily', this.balance)} Daily bonus claimed successfully: +${response.data.data.amount / 10 ** 9}`);
            } else {
                parentPort.postMessage(`${formatLog('daily', this.balance)} Failed to claim daily bonus: Reason unknown`);
            }
        } catch (error) {
            if (error.response && error.response.data.code === 'invalid-request' && error.response.data.message === 'alworm claimed for today') {
                parentPort.postMessage('Daily bonus alworm claimed today.');
            } else {
                parentPort.postMessage({ error: error.message, context: 'claiming daily bonus' });
            }
        }
    }

    async getBalanceData() {
        try {
            const response = await axios.get(balanceUrl, {
                headers: this.headers(),
                httpsAgent: this.agent
            });
            this.balance = response.data.data / 10 ** 9;
        } catch (error) {
            parentPort.postMessage({ error: error.message, context: 'getting balance data' });
        }
    }

    async claimSeed(userName) {
        try {
            parentPort.postMessage(`${formatLog('claim', this.balance)} Attempting to claim...`);
            const response = await axios.post(claimUrl, {}, {
                headers: this.headers(),
                httpsAgent: this.agent
            });
            parentPort.postMessage(`${formatLog('claim', this.balance)} Response from claim API: ${JSON.stringify(response.data)}`);

            if (response.data && response.data.data && response.data.data.amount) {
                parentPort.postMessage(`${formatLog('claim', this.balance)} Claim successful: ${JSON.stringify(response.data)}`);
            } else if (response.data && response.data.message) {
                parentPort.postMessage(`${formatLog('claim', this.balance)} Failed to claim: ${response.data.message}`);
            } else {
                parentPort.postMessage(`${formatLog('claim', this.balance)} Failed to claim: Reason unknown`);
            }

            // Update balance after claiming
            await this.getBalanceData(userName);
        } catch (error) {
            if (error.response && error.response.data.code === 'invalid-request' && error.response.data.message === 'claim too early') {
                parentPort.postMessage(`${formatLog('claim', this.balance)} Claim too early!!`);
            } else {
                parentPort.postMessage(`${formatLog('claim', this.balance)} Claiming...`);
            }
        }
    }

    async checkAndCatchWorms(userName) {
        try {
            parentPort.postMessage(`${formatLog('worm', this.balance)} Checking worms...`);
            const response = await axios.get(wormsUrl, {
                headers: this.headers(),
                httpsAgent: this.agent
            });

            const wormData = response.data.data;

            if (!wormData) {
                parentPort.postMessage(`${formatLog('worm', this.balance)} No worms found.`);
                return;
            }

            parentPort.postMessage(`${formatLog('worm', this.balance)} Received worm type: ${JSON.stringify(wormData.type)}`);

            if (wormData.is_caught) {
                parentPort.postMessage(`${formatLog('worm', this.balance)} Worm already caught.`);
            } else {
                parentPort.postMessage(`${formatLog('worm', this.balance)} Worm detected: Type: ${wormData.type}, Reward: ${wormData.reward}`);
                // Catch the worm if not caught alworm
                if (wormData.id) {
                    await this.catchWorm(wormData, userName);
                } else {
                    parentPort.postMessage(`${formatLog('worm', this.balance)} Worm ID not defined.`);
                }
            }

            parentPort.postMessage(`${formatLog('worm', this.balance)} Next appearance of worm: ${wormData.next_refresh}`);

        } catch (error) {
            parentPort.postMessage({ error: error.message, context: 'checking worms' });
        }
    }

    async catchWorm(wormData, userName) {
        try {
            parentPort.postMessage(`${formatLog('worm', this.balance)} Catching worm with ID: ${wormData.id}...`);
            const response = await axios.post(catchWormUrl, { wormId: wormData.id }, {
                headers: this.headers(),
                httpsAgent: this.agent
            });
            parentPort.postMessage(`${formatLog('worm', this.balance)} Response from catch worm API: ${JSON.stringify(response.data)}`);

            if (response.data.data && response.data.data.status === 'successful') {
                parentPort.postMessage(`${formatLog('worm', this.balance)} Worm caught successfully. Reward: ${response.data.data.reward}`);
            } else {
                parentPort.postMessage(`${formatLog('worm', this.balance)} Failed to catch worm: ${response.data.data.message || 'Reason unknown'}`);
            }

            // Update balance after catching worm
            await this.getBalanceData(userName);
        } catch (error) {
            if (error.response && error.response.data.code === 'resource-not-found' && error.response.data.message === 'worm disappeared') {
                parentPort.postMessage(`${formatLog('worm', this.balance)} Worm has disappeared.`);
            } else {
                parentPort.postMessage({ error: error.message, context: 'catching worm' });
            }
        }
    }

    async checkInventoryAndSell(userName) {
        try {
            parentPort.postMessage(`${formatLog('worm', this.balance)} Checking inventory...`);
            const response = await axios.get(checkInventoryUrl, {
                headers: this.headers(),
                httpsAgent: this.agent
            });

            const inventoryData = response.data.data;

            if (!inventoryData || inventoryData.length === 0) {
                parentPort.postMessage(`${formatLog('worm', this.balance)} Inventory is empty.`);
                return;
            }

            parentPort.postMessage(`${formatLog('worm', this.balance)} Found ${inventoryData.length} items in inventory.`);
            for (const item of inventoryData) {
                parentPort.postMessage(`${formatLog('worm', this.balance)} Item info: ID: ${item.id}, Type: ${item.type}, Reward: ${item.reward}`);
                await this.sellWorm(item, userName);
            }

        } catch (error) {
            parentPort.postMessage({ error: error.message, context: 'checking inventory' });
        }
    }

    async sellWorm(item, userName) {
        try {
            parentPort.postMessage(`${formatLog('worm', this.balance)} Selling item with ID: ${item.id}...`);
            const response = await axios.post(sellWormUrl, { ids: [item.id] }, {
                headers: this.headers(),
                httpsAgent: this.agent
            });
            parentPort.postMessage(`${formatLog('worm', this.balance)} Response from sell worm API: ${JSON.stringify(response.data)}`);

            if (response.data && response.data.data === true) {
                parentPort.postMessage(`${formatLog('worm', this.balance)} Item sold successfully.`);
            } else {
                parentPort.postMessage(`${formatLog('worm', this.balance)} Failed to sell item: ${response.data.message || 'Reason unknown'}`);
            }

            // Update balance after selling item
            await this.getBalanceData(userName);
        } catch (error) {
            parentPort.postMessage({ error: error.message, context: 'selling item' });
        }
    }

    countdown(duration) {
        let remaining = duration;

        const countdownInterval = setInterval(() => {
            const hours = Math.floor(remaining / 3600);
            const minutes = Math.floor((remaining % 3600) / 60);
            const seconds = Math.floor(remaining % 60);

            const timeString = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
            parentPort.postMessage(`${formatLog('waiting', this.balance)} Thời gian còn lại: ${timeString}`);

            remaining -= 1;

            if (remaining < 0) {
                clearInterval(countdownInterval);
                parentPort.postMessage(`${formatLog('waiting', this.balance)} Hoàn tất!`);
            }
        }, 900);
    }

    async changQueryId() {
        // Parse query ID into query parameters
        let queryParams = querystring.parse(this.queryId);

        // Generate random hash
        const randomHash = crypto.randomBytes(32).toString('hex');
        queryParams.hash = randomHash;

        // Adjust auth_date by subtracting 25 seconds
        const newAuthDate = DateTime.now().minus({ seconds: 25 }).toSeconds();
        queryParams.auth_date = Math.floor(newAuthDate);

        // Generate new id
        const currentID = queryParams.query_id;
        let newId = currentID.slice(0, -6); // Keep the first part of queryId

        // Replace the last 6 characters with a combination of random characters and alternating '5'/'6'
        for (let i = 0; i < 6; i++) {
            if (i === 0) {
                // Alternate between '5' and '6' for the first character
                if (currentID[currentID.length - 6 + i] === '5') {
                    newId += '6';
                } else {
                    newId += '5';
                }
            } else {
                // Generate random hex character
                const randomChar = crypto.randomBytes(1).toString('hex')[0]; // Generate 1 random hex character (1 byte)
                newId += randomChar;
            }
        }

        // Update queryParams with newId
        queryParams.query_id = newId;

        // Convert queryParams back to query string format
        const queryString = querystring.stringify(queryParams);

        // Assign this.queryId with updated query string
        this.queryId = queryString;

    }

    async loginWithQueryId() {
        try {
            // await this.changQueryId();
            const response = await axios.get(
                loginUrl,
                {
                    headers: this.headers(),
                    httpsAgent: this.agent
                }
            );
            parentPort.postMessage(`${formatLog('worm', this.balance)} Login successful`);
            const userData = response.data.data;
            const userName = userData.name;

            // Check balance
            await this.getBalanceData(userName);

            // Claim daily login bonus
            await this.claimDailyBonus(userName);

            // Claim seed
            await this.claimSeed(userName);

            // Check and catch worms
            await this.checkAndCatchWorms(userName);

            // Check inventory and sell items
            await this.checkInventoryAndSell(userName);

            // Update last claim time
            // this.lastTimeClaim = DateTime.fromISO(userData.last_claim); // Adjust for timezone difference
            // this.upgradeLevel = this.getCurrentLevel(userData.upgrades, "storage-size");
            // this.updateWaitTime();
            this.waitTime = 45 * MINUTES;
            // Countdown wait time
            if (this.waitTime > 0) {
                this.countdown(this.waitTime);
            }
        } catch (error) {
            if (error.response && error.response.data.code === 'rate-limiting') {
                parentPort.postMessage('Login error: Rate limited. Waiting 1 minute before retrying.');
                await this.delay(60); // Wait 60 seconds if rate limited
            } else if (error.response && error.response.data.code === 'invalid-request' && error.response.data.message === 'user with telegram id alworm exist') {
                parentPort.postMessage('User already exists. Trying to fetch profile data.');
                await this.fetchProfileData();
            } else if (error.code == 'ERR_BAD_REQUEST' && error.response.data.message == 'telegram data expired') {
                parentPort.postMessage(`Query id expired. Change ID`);
                // await this.changQueryId(); // Added await here to ensure the method completes
            } else if (error.code == 'ERR_BAD_REQUEST' && error.response.data.message == 'telegram data is invalid') {
                parentPort.postMessage(`Invalid ID`);
                // await this.changQueryId(); // Added await here to ensure the method completes
            } else {
                parentPort.postMessage({ error: error.message, context: 'login' });
                await this.delay(10); // Wait 10 seconds before switching to next account
            }
        }
    }


    async run() {
        try {
            while (true) {
                await this.loginWithQueryId();
                await this.delay(this.waitTime);
            }
        } catch (error) {
            parentPort.postMessage({ error: error.message, context: 'run' });
        }
    }
}

const seed = new SEED(workerData.queryId, workerData.proxy);
seed.run();
