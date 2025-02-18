/**
 * 获取基金在指定时间区间的净值数据
 * @param {string} fundCode - 基金代码
 * @param {string} startDate - 开始日期 (YYYY-MM-DD)
 * @param {string} endDate - 结束日期 (YYYY-MM-DD)
 * @returns {Promise<Array>} - 返回基金净值数据数组
 */
async function getFundValue(fundCode, startDate, endDate) {
	try {
		// 天天基金网的API
		const url = `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${fundCode}&pageIndex=1&pageSize=100&startDate=${startDate}&endDate=${endDate}`;

		const response = await fetch(url, {
			headers: {
				'Referer': 'http://fundf10.eastmoney.com/',
				'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
			}
		});

		const data = await response.json();
		return data.Data.LSJZList;
	} catch (error) {
		console.error('获取基金数据失败:', error);
		throw error;
	}
}

// 使用示例
async function example() {
	try {
		// 以华夏上证50ETF（510050）为例
		const fundCode = '510050';
		const startDate = '2024-01-01';
		const endDate = '2024-03-20';

		const fundData = await getFundValue(fundCode, startDate, endDate);
		console.log('基金净值数据:', fundData);

		// 打印具体的净值信息
		fundData.forEach(item => {
			console.log(`日期: ${item.FSRQ}, 单位净值: ${item.DWJZ}, 累计净值: ${item.LJJZ}`);
		});
	} catch (error) {
		console.error('示例运行失败:', error);
	}
}

// 运行示例
example(); 
