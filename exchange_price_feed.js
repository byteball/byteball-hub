/*jslint node: true */
'use strict';
const async = require('async');
const request = require('request').defaults({timeout: 10 * 1000});
const eventBus = require('ocore/event_bus.js');
const network = require('ocore/network.js');
const storage = require('ocore/storage.js');
require("tls").DEFAULT_ECDH_CURVE = "auto"; // fix for Node 8

const rates = {};
const decimalsInfo = {};

function updateBitfinexRates(state, onDone) {
	const apiUri = 'https://api.bitfinex.com/v1/pubticker/btcusd';
	request(apiUri, function (error, response, body) {
		if (!error && response.statusCode == 200) {
			let price;
			try{
				price = parseFloat(JSON.parse(body).last_price);
				console.log("new exchange rate: BTC-USD = " + price);
			}
			catch(e){
				console.log('bad response from bitfinex:', e);
				return onDone();
			}
			if (price) {
				rates['BTC_USD'] = price;
				state.updated = true;
			}
		}
		else {
			console.error("Can't get currency rates from bitfinex", error, body);
		}
		onDone();
	});
}

function updateBittrexRates(state, onDone) {
	const apiUri = 'https://api.bittrex.com/v3/markets/GBYTE-BTC/ticker';
	request(apiUri, function (error, response, body) {
		if (!error && response.statusCode == 200) {
			let price;
			try{
				price = parseFloat(JSON.parse(body).lastTradeRate);
				console.log("new exchange rate: GBYTE-BTC = " + price);
			}
			catch(e){
				console.log('bad response from bittrex:', e);
				return onDone();
			}
			if (price) {
				rates['GBYTE_BTC'] = price;
				if (rates['BTC_USD']) {
					rates['GBYTE_USD'] = price * rates['BTC_USD'];
				}
				state.updated = true;
			}
		}
		else {
			console.error("Can't get currency rates from bittrex", error, body);
		}
		onDone();
	});
}

function updateOstableRates(state, onDone) {
	const apiUri = 'https://data.ostable.org/api/v1/summary';
	request(apiUri, function (error, response, body) {
		if (!error && response.statusCode == 200) {
			let arrCoinInfos;
			try {arrCoinInfos = JSON.parse(body);} catch(e){}
			if (!arrCoinInfos) {
				console.log('bad rates from ostable data api');
				return onDone();
			}
			arrCoinInfos.forEach(coinInfo => {
				if (!coinInfo.last_price || coinInfo.quote_id !== 'base' || coinInfo.base_id === 'base')
					return;
				console.log("new exchange rate: " + coinInfo.market_name + " = " + coinInfo.last_price);
				if (rates['GBYTE_USD']) {
					rates[coinInfo.base_id +'_USD'] = rates['GBYTE_USD'] * coinInfo.last_price;
				}
				state.updated = true;
			});
			arrCoinInfos.forEach(coinInfo => {
				if (!coinInfo.last_price || coinInfo.quote_id === 'base' || coinInfo.base_id === 'base')
					return;
				console.log("new exchange rate: " + coinInfo.market_name + " = " + coinInfo.last_price);
				if (rates[coinInfo.quote_id +'_USD']) {
					rates[coinInfo.base_id +'_USD'] = rates[coinInfo.quote_id +'_USD'] * coinInfo.last_price;
					state.updated = true;
				}
			});
		}
		else {
			console.error("Can't get currency rates from ostable data api", error, body);
		}
		onDone();
	});
}

function updateOstableReferralsRates(state, onDone) {
	const apiUri = 'https://referrals.ostable.org/prices';
	request(apiUri, function (error, response, body) {
		if (!error && response.statusCode == 200) {
			let arrCoinInfos;
			try {arrCoinInfos = JSON.parse(body).data;} catch(e){}
			if (!arrCoinInfos) {
				console.log('bad rates from ostable referrals api');
				return onDone();
			}
			for (var asset in arrCoinInfos) {
				if (!asset || asset === 'base')
					continue;
				rates[asset +'_USD'] = arrCoinInfos[asset];
				state.updated = true;
			}
		}
		else {
			console.error("Can't get currency rates from ostable referrals api", error, body);
		}
		onDone();
	});
}

function requestAsync(url) {
	return new Promise((resolve, reject) => {
		request(url, (error, response, body) => {
			if (error)
				return reject(error);
			if (response.statusCode != 200)
				return reject("non-200 status code " + response.statusCode);
			resolve(body);
		});
	});
}


const nativeSymbols = {
	Ethereum: 'ETH',
	BSC: 'BNB',
};

const coingeckoChains = {
	Ethereum: 'ethereum',
	BSC: 'binance-smart-chain',
};

const fetchCryptocompareExchangeRate = async (in_currency, out_currency) => {
	let data = await requestAsync(`https://min-api.cryptocompare.com/data/price?fsym=${in_currency}&tsyms=${out_currency}`);
	data = JSON.parse(data);
	if (!data[out_currency])
		throw new Error(`no ${out_currency} in response ${JSON.stringify(data)}`);
	return data[out_currency];
}

async function fetchERC20ExchangeRate(chain, token_address, quote) {
	if (token_address === '0x4DBCdF9B62e891a7cec5A2568C3F4FAF9E8Abe2b') // USDC rinkeby
		token_address = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
	if (token_address === '0xbF7A7169562078c96f0eC1A8aFD6aE50f12e5A99') // BAT rinkeby
		token_address = '0x0D8775F648430679A709E98d2b0Cb6250d2887EF';
	if (token_address === '0xeD24FC36d5Ee211Ea25A80239Fb8C4Cfd80f12Ee') // BUSD testnet
		token_address = '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56';
	let data = await requestAsync(`https://api.coingecko.com/api/v3/coins/${chain}/contract/${token_address.toLowerCase()}`);
	data = JSON.parse(data);
	const prices = data.market_data.current_price;
	quote = quote.toLowerCase();
	if (!prices[quote])
		throw new Error(`no ${quote} in response ${JSON.stringify(data)}`);
	return prices[quote];
}

async function updateImportedAssetsRates(state, onDone) {
	const import_factory_aa = 'KFAJZYLH6T3W2U6LNQJYIWXJVSBB24FN';
	storage.readAAStateVars(import_factory_aa, 'import_', 'import_', 0, async vars => {
		for (let var_name in vars) {
			const { asset, asset_decimals, home_network, home_asset } = vars[var_name];
			const chain = coingeckoChains[home_network];
			if (!chain) {
				console.error('unknown network ' + home_network);
				continue;
			}
			decimalsInfo[asset] = asset_decimals; // cache for updateOswapPoolTokenRates()
			try {
				if (home_asset === '0x0000000000000000000000000000000000000000')
					rates[asset + '_USD'] = await fetchCryptocompareExchangeRate(nativeSymbols[home_network], 'USD');
				else
					rates[asset + '_USD'] = await fetchERC20ExchangeRate(chain, home_asset, 'USD');
				state.updated = true;
			}
			catch (e) {
				console.error('failed to fetch the rate of', home_asset, 'on', home_network, e);
			}
		}
		onDone();
	});
}

async function updateOswapPoolTokenRates(state, onDone) {
	const pool_factory_aa = 'B22543LKSS35Z55ROU4GDN26RT6MDKWU';
	const pools = {};
	const vars = await storage.readAAStateVars(pool_factory_aa, 'pools.', 'pools.', 0);
	const db = require('ocore/db.js');

	for (let var_name in vars) {
		const [prefix, pool_address, key] = var_name.split('.');
		pools[pool_address] = pools[pool_address] || {};
		pools[pool_address][key] = vars[var_name];
	}
	for (let pool_address in pools){
		try {
			const asset = pools[pool_address].asset;
			const asset0 = pools[pool_address].asset0;
			const asset1 = pools[pool_address].asset1;
			if (!asset || !asset0 || !asset1){
				console.error('pool assets missing', pool_address);
				continue;
			}
			if (asset0 !== 'base' && asset1 !== 'base') {
				if (!getAssetUSDPrice(asset0) || !getAssetUSDPrice(asset1)) {
					console.error('price missing for pool assets', pool_address);
					continue;
				}
			}
			else if (!getAssetUSDPrice(asset0) && !getAssetUSDPrice(asset1)) {
				console.error('both prices missing for pool assets', pool_address);
				continue;
			}

			const balances = await storage.readAABalances(db, pool_address); 
			if (!balances[asset0] || !balances[asset1]) {
				console.error('pool balances empty', pool_address);
				continue;
			}
			let asset0value = await getAssetAmount(balances[asset0], asset0) * getAssetUSDPrice(asset0);
			let asset1value = await getAssetAmount(balances[asset1], asset1) * getAssetUSDPrice(asset1);
			if (!asset0value || !asset1value) {
				// if traded with GBYTE, pool total pool size is double the GBYTE
				if (asset0 !== 'base' && asset1 !== 'base') {
					console.error('pool asset no value', pool_address, balances);
					continue;
				}
				else if (asset0 === 'base') {
					asset1value = asset0value;
				}
				else if (asset1 === 'base') {
					asset0value = asset1value;
				}
			}
			const total_pool_value = asset0value + asset1value;

			const pool_data = await storage.readAAStateVars(pool_address, 'supply', 'supply', 1);
			if (!pool_data['supply']) {
				console.error('pool asset supply empty', pool_address);
				continue;
			}
			rates[asset + '_USD'] = total_pool_value / pool_data['supply'];
			state.updated = true;
		}
		catch (e) {
			console.error('failed to fetch the rate for', pool_address, 'pool', e);
		}
	}
	onDone();

	async function getAssetAmount(balance, asset) {
		const asset_registry = 'O6H6ZIFI57X3PLTYHOCVYPP5A553CYFQ';
		let decimals = null;
		if (asset === 'base')
			decimals = 9;
		else if (decimalsInfo[asset])
			decimals = decimalsInfo[asset];
		else {
			const current_desc = await storage.readAAStateVars(asset_registry, "current_desc_" + asset, "current_desc_" + asset, 1);
			if (current_desc["current_desc_" + asset]) {
				const desc_hash = current_desc["current_desc_" + asset];
				const asset_data = await storage.readAAStateVars(asset_registry, 'decimals_' + desc_hash, 'decimals_' + desc_hash, 1);
				if (asset_data['decimals_'+ desc_hash]) {
					decimals = asset_data['decimals_'+ desc_hash];
					decimalsInfo[asset] = decimals;
				}
			}
		}
		if (decimals === null)
			return 0;
		return balance / (10 ** decimals);
	}

	function getAssetUSDPrice(asset){
		if (asset === 'base') asset = 'GBYTE';
		if (rates[asset + '_USD'])
			return rates[asset + '_USD'];
	}
}

function updateFreebeRates(state, onDone) {
	const apiUri = 'https://blackbytes.io/last';
	request(apiUri, function (error, response, body) {
		if (!error && response.statusCode == 200) {
			let price;
			try{
				price = parseFloat(JSON.parse(body).price_bytes);
				console.log("new exchange rate: GBB-GBYTE = " + price);
			}
			catch(e){
				console.log('bad response from freebe:', e);
				return onDone();
			}
			if (rates['GBYTE_USD'] && price) {
				rates['GBB_GBYTE'] = price;
				rates['GBB_USD'] = rates['GBYTE_USD'] * price;
				state.updated = true;
			}
			if (rates['GBYTE_BTC'] && price) {
				rates['GBB_BTC'] = rates['GBYTE_BTC'] * price;
				state.updated = true;
			}
		}
		else {
			console.error("Can't get currency rates from freebe", error, body);
		}
		onDone();
	});
}

function updateBTC_20200701Rates(state, onDone) {
	// transactions.json is more up-to-date than ticker.json
	const apiUri = 'https://cryptox.pl/api/BTC_20200701BTC/transactions.json';
	request(apiUri, function (error, response, body) {
		if (!error && response.statusCode == 200) {
			let price;
			try{
				price = parseFloat(JSON.parse(body)[0].price);
				console.log("new exchange rate: BTC_20200701-BTC = " + price);
			}
			catch(e){
				console.log('bad response from cryptox:', e);
				return onDone();
			}
			if (rates['BTC_USD'] && price) {
				rates['ZVuuh5oWAJnISvtOFdzHAa7QTl/CG7T2KDfAGB4qSxk=_USD'] = rates['BTC_USD'] * price;
				state.updated = true;
			}
		}
		else {
			console.error("Can't get currency rates from cryptox", error, body);
		}
		onDone();
	});
}

function updateRates(){
	let state = {updated: false};
	async.series([
		function(cb){
			updateBitfinexRates(state, cb);
		},
		function(cb){
			updateBittrexRates(state, cb);
		},
		// function(cb){
		// 	updateOstableRates(state, cb);
		// },
		function(cb){
			updateOstableReferralsRates(state, cb);
		},
		function(cb){
			updateImportedAssetsRates(state, cb);
		},
		function(cb){
			updateOswapPoolTokenRates(state, cb);
		},
		function(cb){
			updateFreebeRates(state, cb);
		},
		// function(cb){
		// 	updateBTC_20200701Rates(state, cb);
		// },
	], function(){
		console.log(rates);
		if (state.updated)
			broadcastNewRates();
	});
}

function broadcastNewRates(){
	network.sendAllInboundJustsaying('exchange_rates', rates);
}

eventBus.on('client_logged_in', function(ws){
	if (Object.keys(rates).length > 0)
		network.sendJustsaying(ws, 'exchange_rates', rates);
});

updateRates();
setInterval(updateRates, 1000 * 60 * 5);

exports.rates = rates;
