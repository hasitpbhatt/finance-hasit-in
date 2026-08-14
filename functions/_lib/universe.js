// Curated universe of US-listed stocks and ETFs used for the overview and
// screener. Free Yahoo Finance endpoints are queried for these symbols; the
// list is intentionally broad across sectors so filters are meaningful.
// Add/remove tickers freely — there are no API keys involved.

export const UNIVERSE = [
  // --- Mega / large cap tech ---
  'AAPL', 'MSFT', 'GOOGL', 'GOOG', 'AMZN', 'META', 'NVDA', 'TSLA', 'AVGO',
  'ORCL', 'ADBE', 'CRM', 'AMD', 'INTC', 'CSCO', 'IBM', 'QCOM', 'TXN', 'AMAT',
  'PYPL', 'NFLX', 'INTU', 'NOW', 'ADP', 'ADSK', 'MU', 'LRCX', 'KLAC', 'SNPS',
  'CDNS', 'APH', 'ANET', 'FTNT', 'PANW', 'CRWD', 'ZS', 'DDOG', 'SNOW', 'ABNB',

  // --- Financials ---
  'JPM', 'BAC', 'WFC', 'GS', 'MS', 'C', 'BLK', 'SCHW', 'AXP', 'USB', 'PNC',
  'TROW', 'SPGI', 'MCO', 'AON', 'ICE', 'CME', 'COF', 'BK', 'TFC',

  // --- Healthcare ---
  'JNJ', 'UNH', 'LLY', 'PFE', 'MRK', 'ABBV', 'TMO', 'ABT', 'DHR', 'BMY',
  'AMGN', 'GILD', 'CVS', 'CI', 'ISRG', 'VRTX', 'REGN', 'ZTS', 'MMC',

  // --- Consumer ---
  'WMT', 'COST', 'PG', 'KO', 'PEP', 'MCD', 'NKE', 'SBUX', 'TGT', 'HD',
  'LOW', 'MO', 'PM', 'CL', 'EL', 'MNST', 'KHC', 'GIS', 'MDLZ', 'YUM',

  // --- Energy / industrials / materials ---
  'XOM', 'CVX', 'COP', 'SLB', 'EOG', 'PSX', 'MPC', 'VLO', 'CAT', 'DE',
  'BA', 'GE', 'HON', 'UNP', 'RTX', 'LMT', 'MMM', 'UPS', 'FDX', 'NEE',
  'DUK', 'SO', 'AEP', 'LIN', 'SHW', 'APD', 'FCX', 'NEM', 'NUE', 'VMC',

  // --- Comms / media / other ---
  'VZ', 'T', 'TMUS', 'DIS', 'CMCSA', 'CHTR', 'EA', 'ATVI',

  // --- Popular ETFs ---
  'SPY', 'QQQ', 'VTI', 'VOO', 'IWM', 'VEA', 'VWO', 'GLD', 'SLV', 'TLT',
  'AGG', 'IVV', 'IJH', 'IJR', 'VUG', 'VTV', 'VYM', 'SCHD', 'ARKK', 'XLF',
  'XLK', 'XLE', 'XLV', 'XLI', 'XLY', 'XLP', 'XLB', 'XLRE', 'XLU', 'KBE',
  'VHT', 'VGT', 'VNQ', 'DIA', 'MDY',
];
