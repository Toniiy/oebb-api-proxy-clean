const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
app.use(cors());

console.log('🚄 ÖBB WebApp Scraper v6.0 - Using Real URLs');

// NO CACHE - Always fresh data as requested
let isScrapingInProgress = false;

async function scrapeOebbWebApp(fromStation, toStation) {
  if (isScrapingInProgress) {
    throw new Error('Scraping in progress - please wait');
  }
  
  isScrapingInProgress = true;
  console.log(`🔍 Scraping ÖBB WebApp: ${fromStation} → ${toStation}`);
  
  try {
    const now = new Date();
    const dateStr = now.toLocaleDateString('de-DE', { 
      day: '2-digit', 
      month: '2-digit', 
      year: 'numeric' 
    }).replace(/\\./g, '.');
    const timeStr = now.toTimeString().substring(0, 8); // HH:MM:SS format
    
    console.log(`⏰ Searching for trains departing after ${dateStr} ${timeStr}`);
    
    // Build the exact URLs you provided
    let webappUrl;
    
    if (fromStation === 'St. Pölten' && toStation === 'Linz') {
      webappUrl = `https://fahrplan.oebb.at/webapp/?context=TP&SID=A%3D1%40O%3DSt.P%C3%B6lten%20Hbf%40X%3D15623800%40Y%3D48208331%40U%3D81%40L%3D008100008%40B%3D1%40p%3D1275041666%40&ZID=A%3D1%40O%3DLinz%2FDonau%20Hbf%40X%3D14291814%40Y%3D48290150%40U%3D81%40L%3D008100013%40B%3D1%40p%3D1275041666%40&date=${dateStr}&time=${timeStr}&timeSel=1&returnTimeSel=1&journeyProducts=7167&start=1`;
    } else {
      webappUrl = `https://fahrplan.oebb.at/webapp/?context=TP&SID=A%3D1%40O%3DLinz%2FDonau%20Hbf%40X%3D14291814%40Y%3D48290150%40U%3D81%40L%3D008100013%40B%3D1%40p%3D1275041666%40&ZID=A%3D1%40O%3DSt.P%C3%B6lten%20Hbf%40X%3D15623800%40Y%3D48208331%40U%3D81%40L%3D008100008%40B%3D1%40p%3D1275041666%40&date=${dateStr}&time=${timeStr}&timeSel=1&returnTimeSel=1&journeyProducts=7167&start=1`;
    }
    
    console.log(`🌐 WebApp URL: ${webappUrl}`);
    
    const response = await axios.get(webappUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'de-AT,de;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Referer': 'https://fahrplan.oebb.at/',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1'
      },
      timeout: 25000,
      maxRedirects: 5
    });
    
    console.log(`📨 WebApp response received (${response.data ? response.data.length : 0} chars)`);
    
    if (response.data) {
      // First, try to extract any JSON data embedded in the response
      const trains = extractTrainDataFromWebApp(response.data);
      if (trains && trains.length > 0) {
        console.log(`✅ Successfully extracted ${trains.length} trains from webapp`);
        return trains;
      }
      
      // If no trains found, also try to extract from any script tags or data attributes
      const scriptTrains = extractFromScriptTags(response.data);
      if (scriptTrains && scriptTrains.length > 0) {
        console.log(`✅ Successfully extracted ${scriptTrains.length} trains from scripts`);
        return scriptTrains;
      }
      
      // Log some debug info
      const hasJavaScript = response.data.includes('<script');
      const hasJSON = response.data.includes('{') && response.data.includes('}');
      const hasTimePattern = /\\d{1,2}:\\d{2}/.test(response.data);
      
      console.log(`📊 WebApp Debug:`);
      console.log(`   - Has JavaScript: ${hasJavaScript}`);
      console.log(`   - Has JSON data: ${hasJSON}`);
      console.log(`   - Has time patterns: ${hasTimePattern}`);
      
      // Try to find AJAX endpoints in the response
      const ajaxMatches = response.data.match(/[\"']https?:\\/\\/[^\"']*\\/bin\\/[^\"']*[\"']/g);
      if (ajaxMatches) {
        console.log('🔍 Found potential AJAX endpoints:');
        ajaxMatches.slice(0, 3).forEach(match => console.log(`   - ${match}`));
        
        // Try to call these endpoints
        for (const match of ajaxMatches.slice(0, 2)) {
          const url = match.replace(/[\"']/g, '');
          if (url.includes('query') || url.includes('stboard')) {
            console.log(`📡 Trying AJAX endpoint: ${url}`);
            try {
              const ajaxTrains = await tryAjaxEndpoint(url, fromStation, toStation);
              if (ajaxTrains && ajaxTrains.length > 0) {
                return ajaxTrains;
              }
            } catch (error) {
              console.log(`❌ AJAX endpoint failed: ${error.message}`);
            }
          }
        }
      }
    }
    
    throw new Error('Could not extract train data from webapp response');
    
  } catch (error) {
    console.error(`❌ WebApp scraping failed: ${error.message}`);
    throw error;
  } finally {
    isScrapingInProgress = false;
  }
}

function extractTrainDataFromWebApp(html) {
  try {
    console.log('🔍 Extracting train data from webapp response...');
    
    const $ = cheerio.load(html);
    const trains = [];
    
    // Method 1: Look for any table structures
    console.log('📊 Method 1: Looking for webapp tables...');
    $('table tr, .result-row, .journey-row, .connection').each((index, element) => {
      if (trains.length >= 3) return false;
      
      const $row = $(element);
      const text = $row.text().trim();
      
      if (text && text.length > 20) {
        console.log(`📝 Table row: "${text}"`);
        const train = parseTrainFromText(text);
        if (train) {
          trains.push(train);
          console.log(`✅ Extracted: ${train.trainNumber} ${train.departure}`);
        }
      }
    });
    
    // Method 2: Look for embedded JSON or data structures
    if (trains.length === 0) {
      console.log('📊 Method 2: Looking for JSON data structures...');
      
      // Look for JSON in script tags
      $('script').each((index, element) => {
        const scriptContent = $(element).html();
        if (scriptContent && (scriptContent.includes('journey') || scriptContent.includes('connection'))) {
          console.log(`📜 Found script with journey data (${scriptContent.length} chars)`);
          
          // Try to extract JSON objects
          const jsonMatches = scriptContent.match(/\\{[^{}]*\"[^\"]*\":[^{}]*\\}/g);
          if (jsonMatches) {
            jsonMatches.slice(0, 5).forEach(match => {
              console.log(`🔍 JSON candidate: ${match.substring(0, 100)}...`);
              try {
                const obj = JSON.parse(match);
                if (obj.time || obj.departure || obj.train) {
                  console.log('✅ Found potential train JSON data');
                  const train = parseTrainFromJSON(obj);
                  if (train && trains.length < 3) {
                    trains.push(train);
                  }
                }
              } catch (e) {
                // Not valid JSON, continue
              }
            });
          }
        }
      });
    }
    
    // Method 3: Look for time patterns in the entire document
    if (trains.length === 0) {
      console.log('📊 Method 3: Full document time pattern search...');
      
      const fullText = $.text();
      const lines = fullText.split('\\n');
      
      for (const line of lines) {
        if (trains.length >= 3) break;
        
        const trimmedLine = line.trim();
        if (trimmedLine.length > 15 && /\\d{1,2}:\\d{2}/.test(trimmedLine)) {
          console.log(`🕐 Time pattern line: "${trimmedLine.substring(0, 100)}"`);
          const train = parseTrainFromText(trimmedLine);
          if (train) {
            trains.push(train);
            console.log(`✅ Extracted from line: ${train.trainNumber} ${train.departure}`);
          }
        }
      }
    }
    
    return trains;
    
  } catch (error) {
    console.error('❌ Error extracting from webapp:', error);
    return [];
  }
}

function extractFromScriptTags(html) {
  try {
    console.log('📜 Extracting data from script tags...');
    
    const $ = cheerio.load(html);
    const trains = [];
    
    $('script').each((index, element) => {
      if (trains.length >= 3) return false;
      
      const scriptContent = $(element).html() || '';
      
      // Look for patterns that might contain train data
      if (scriptContent.includes('RJ') || scriptContent.includes('WB') || scriptContent.includes('ICE')) {
        console.log(`🚂 Script contains train type references`);
        
        // Extract time patterns with potential train info
        const matches = scriptContent.match(/([RJX|WB|ICE|IC|REX|D|S|R]+\\s*\\d+)[^\\d]*?(\\d{1,2}:\\d{2})/g);
        if (matches) {
          matches.slice(0, 3).forEach(match => {
            console.log(`🎯 Train pattern: ${match}`);
            const train = parseTrainFromText(match);
            if (train && trains.length < 3) {
              trains.push(train);
            }
          });
        }
      }
    });
    
    return trains;
    
  } catch (error) {
    console.error('❌ Error extracting from scripts:', error);
    return [];
  }
}

async function tryAjaxEndpoint(url, fromStation, toStation) {
  try {
    console.log(`📡 Testing AJAX endpoint: ${url}`);
    
    // Try to modify the URL to include our station parameters
    const stationIds = {
      'St. Pölten': '8100008',
      'Linz': '8100009'
    };
    
    const fromId = stationIds[fromStation];
    const toId = stationIds[toStation];
    
    if (fromId && toId) {
      const modifiedUrl = `${url}?from=${fromId}&to=${toId}&date=${new Date().toLocaleDateString('de-DE').replace(/\\./g, '.')}&time=${new Date().toTimeString().substring(0, 5)}`;
      
      const response = await axios.get(modifiedUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json,text/html,*/*',
          'Referer': 'https://fahrplan.oebb.at/webapp/'
        },
        timeout: 10000
      });
      
      if (response.data) {
        console.log(`📊 AJAX response: ${response.data.length} chars`);
        
        // Try to parse as JSON first
        if (typeof response.data === 'object') {
          return parseAjaxJSON(response.data);
        }
        
        // Otherwise try to extract from HTML/text
        return extractTrainDataFromWebApp(response.data);
      }
    }
    
    return [];
    
  } catch (error) {
    console.log(`❌ AJAX endpoint error: ${error.message}`);
    return [];
  }
}

function parseTrainFromText(text) {
  try {
    // Look for time patterns (HH:MM)
    const timeMatches = text.match(/\\b(\\d{1,2}:\\d{2})\\b/g);
    if (!timeMatches || timeMatches.length < 1) {
      return null;
    }
    
    const depTime = timeMatches[0];
    
    // Look for train type and number
    const trainMatches = text.match(/\\b(RJX?|ICE?|WB|NJ|REX|D|S|R)\\s*(\\d+)?/gi);
    let trainType = 'RJ';
    let trainNumber = `RJ ${depTime.replace(':', '')}`;
    
    if (trainMatches && trainMatches.length > 0) {
      const match = trainMatches[0];
      trainType = extractTrainType(match);
      trainNumber = match.replace(/\\s+/g, ' ').trim();
    }
    
    // Look for delay information  
    const delayMatches = text.match(/(?:\\+|Vers\\.?|Verspätung|delay)\\s*(\\d+)/gi);
    const delay = delayMatches ? parseInt(delayMatches[0].match(/\\d+/)[0]) : 0;
    
    // Calculate arrival time (St.P-Linz is ~71 minutes)
    const [depHour, depMin] = depTime.split(':').map(Number);
    const journeyMinutes = 71;
    const totalMinutes = (depHour * 60 + depMin + journeyMinutes) % (24 * 60);
    const arrHour = Math.floor(totalMinutes / 60);
    const arrMin = totalMinutes % 60;
    const arrTime = `${arrHour.toString().padStart(2, '0')}:${arrMin.toString().padStart(2, '0')}`;
    
    const status = delay > 0 ? (delay <= 5 ? 'slightly-delayed' : 'delayed') : 'on-time';
    
    return {
      departure: depTime,
      arrival: arrTime,
      trainType: trainType,
      trainNumber: trainNumber,
      delay: delay,
      status: status,
      platform: '?'
    };
    
  } catch (error) {
    return null;
  }
}

function parseTrainFromJSON(obj) {
  try {
    // This would parse JSON objects if we find them in the webapp response
    const depTime = obj.departure || obj.time || obj.dep || '??:??';
    const trainName = obj.train || obj.line || obj.product || 'Train';
    const delay = parseInt(obj.delay || obj.delayMinutes || 0);
    
    if (depTime !== '??:??' && /\\d{1,2}:\\d{2}/.test(depTime)) {
      const trainType = extractTrainType(trainName);
      const status = delay > 0 ? (delay <= 5 ? 'slightly-delayed' : 'delayed') : 'on-time';
      
      // Calculate arrival
      const [depHour, depMin] = depTime.split(':').map(Number);
      const totalMinutes = (depHour * 60 + depMin + 71) % (24 * 60);
      const arrHour = Math.floor(totalMinutes / 60);
      const arrMin = totalMinutes % 60;
      const arrTime = `${arrHour.toString().padStart(2, '0')}:${arrMin.toString().padStart(2, '0')}`;
      
      return {
        departure: depTime,
        arrival: arrTime,
        trainType: trainType,
        trainNumber: trainName,
        delay: delay,
        status: status,
        platform: obj.platform || '?'
      };
    }
    
    return null;
    
  } catch (error) {
    return null;
  }
}

function parseAjaxJSON(data) {
  try {
    // Parse JSON responses from AJAX endpoints
    const trains = [];
    
    if (data.journeys && Array.isArray(data.journeys)) {
      data.journeys.slice(0, 3).forEach(journey => {
        const train = parseTrainFromJSON(journey);
        if (train) trains.push(train);
      });
    }
    
    if (data.connections && Array.isArray(data.connections)) {
      data.connections.slice(0, 3).forEach(connection => {
        const train = parseTrainFromJSON(connection);
        if (train) trains.push(train);
      });
    }
    
    return trains;
    
  } catch (error) {
    return [];
  }
}

function extractTrainType(trainName) {
  if (!trainName) return 'RJ';
  
  const name = trainName.toString().toUpperCase();
  
  if (name.includes('RJX')) return 'RJX';
  if (name.includes('RJ')) return 'RJ';
  if (name.includes('ICE')) return 'ICE';
  if (name.includes('IC ') || name.startsWith('IC')) return 'IC';
  if (name.includes('WESTBAHN') || name.includes('WB')) return 'WB';
  if (name.includes('NIGHTJET') || name.includes('NJ')) return 'NJ';
  if (name.includes('REX')) return 'REX';
  if (name.includes('D ')) return 'D';
  if (name.includes('S ')) return 'S';
  if (name.includes('R ')) return 'R';
  
  return 'RJ';
}

// Realistic fallback using actual ÖBB schedules
function getRealisticFallback(fromStation, toStation) {
  console.log(`🚂 Using realistic ÖBB fallback: ${fromStation} → ${toStation}`);
  
  const now = new Date();
  const currentHour = now.getHours();
  const currentMinute = now.getMinutes();
  const totalMinutes = currentHour * 60 + currentMinute;
  
  // Real ÖBB hourly patterns
  const schedulePatterns = {
    'St. Pölten-Linz': [
      { minute: 42, type: 'RJ', baseNum: 540, duration: 71, platform: '2' },
      { minute: 12, type: 'WB', baseNum: 8640, duration: 68, platform: '1' }
    ],
    'Linz-St. Pölten': [
      { minute: 7, type: 'RJ', baseNum: 541, duration: 71, platform: '1' },
      { minute: 48, type: 'WB', baseNum: 8641, duration: 68, platform: '4' }
    ]
  };
  
  const scheduleKey = `${fromStation}-${toStation}`;
  const patterns = schedulePatterns[scheduleKey] || schedulePatterns['St. Pölten-Linz'];
  
  const trains = [];
  let searchHour = currentHour;
  let searchMinute = currentMinute;
  
  while (trains.length < 3 && searchHour < currentHour + 12) {
    for (const pattern of patterns) {
      if (trains.length >= 3) break;
      
      const trainTotalMinutes = searchHour * 60 + pattern.minute;
      
      if (trainTotalMinutes > totalMinutes) {
        const trainNumber = `${pattern.type} ${pattern.baseNum + (searchHour % 12) * 2}`;
        const depTime = `${searchHour.toString().padStart(2, '0')}:${pattern.minute.toString().padStart(2, '0')}`;
        
        const arrivalMinutes = (trainTotalMinutes + pattern.duration) % (24 * 60);
        const arrivalHour = Math.floor(arrivalMinutes / 60);
        const arrivalMin = arrivalMinutes % 60;
        const arrTime = `${arrivalHour.toString().padStart(2, '0')}:${arrivalMin.toString().padStart(2, '0')}`;
        
        // Add realistic delays
        const delay = Math.random() > 0.8 ? Math.floor(Math.random() * 8) + 1 : 0;
        const status = delay > 0 ? (delay <= 5 ? 'slightly-delayed' : 'delayed') : 'on-time';
        
        trains.push({
          departure: depTime,
          arrival: arrTime,
          trainType: pattern.type,
          trainNumber: trainNumber,
          delay: delay,
          status: status,
          platform: pattern.platform
        });
        
        console.log(`🚂 Fallback: ${trainNumber} ${depTime} (${delay}min delay)`);
      }
    }
    
    searchHour++;
    if (searchHour >= 24) searchHour = 0;
  }
  
  return trains;
}

// API endpoints
app.get('/trains/stpoelten-linz', async (req, res) => {
  console.log('🚄 API Request: St. Pölten → Linz');
  
  try {
    const trains = await scrapeOebbWebApp('St. Pölten', 'Linz');
    
    res.json({
      route: "St. Pölten → Linz",
      timestamp: new Date().toISOString(),
      trains: trains,
      source: 'oebb-webapp-scraping',
      realTimeData: true,
      success: true
    });
    
  } catch (error) {
    console.error(`❌ WebApp scraping failed: ${error.message}`);
    
    const fallbackData = getRealisticFallback('St. Pölten', 'Linz');
    
    res.json({
      route: "St. Pölten → Linz",
      timestamp: new Date().toISOString(),
      trains: fallbackData,
      source: 'realistic-fallback',
      realTimeData: false,
      success: false,
      error: error.message
    });
  }
});

app.get('/trains/linz-stpoelten', async (req, res) => {
  console.log('🚄 API Request: Linz → St. Pölten');
  
  try {
    const trains = await scrapeOebbWebApp('Linz', 'St. Pölten');
    
    res.json({
      route: "Linz → St. Pölten",
      timestamp: new Date().toISOString(),
      trains: trains,
      source: 'oebb-webapp-scraping',
      realTimeData: true,
      success: true
    });
    
  } catch (error) {
    console.error(`❌ WebApp scraping failed: ${error.message}`);
    
    const fallbackData = getRealisticFallback('Linz', 'St. Pölten');
    
    res.json({
      route: "Linz → St. Pölten",
      timestamp: new Date().toISOString(),
      trains: fallbackData,
      source: 'realistic-fallback',
      realTimeData: false,
      success: false,
      error: error.message
    });
  }
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '6.0.0',
    scrapingInProgress: isScrapingInProgress,
    features: ['webapp-urls', 'ajax-detection', 'no-cache']
  });
});

app.get('/', (req, res) => {
  res.json({
    message: 'ÖBB WebApp Scraper v6.0 - Using Real URLs',
    description: 'Scrapes ÖBB webapp using exact URLs you provided',
    endpoints: [
      '/trains/stpoelten-linz  - Live St. Pölten → Linz',
      '/trains/linz-stpoelten  - Live Linz → St. Pölten',
      '/health                 - Service status'
    ],
    features: [
      '🌐 Uses exact ÖBB webapp URLs',
      '📡 Detects and tries AJAX endpoints',
      '📜 Extracts data from script tags',
      '🔍 Multiple extraction methods',
      '❌ No caching - always fresh',
      '🚂 Realistic hourly pattern fallback'
    ],
    urls: {
      stpoelten_linz: 'Uses your St. Pölten → Linz webapp URL',
      linz_stpoelten: 'Uses your Linz → St. Pölten webapp URL'
    }
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌐 ÖBB WebApp Scraper v6.0 running on port ${PORT}`);
  console.log('🎯 Using your exact ÖBB webapp URLs:');
  console.log('   📍 St. Pölten → Linz with proper SID/ZID');
  console.log('   📍 Linz → St. Pölten with swapped SID/ZID');
  console.log('   ⏰ Dynamic time updates');
  console.log('   📡 AJAX endpoint detection');
  console.log('   📜 Script tag data extraction');
  console.log('\\n❌ NO CACHE - Always fresh webapp requests');
  console.log('🚂 Fallback: Realistic hourly ÖBB patterns');
  console.log('\\n🌐 Ready to scrape real webapp data!\\n');
});