const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
app.use(cors());

console.log('🚄 ÖBB Proxy v7.0 - Transport REST API (Real Data)');

let isScrapingInProgress = false;

async function fetchOebbTransportRest(fromStation, toStation) {
  if (isScrapingInProgress) {
    throw new Error('API call in progress - please wait');
  }
  
  isScrapingInProgress = true;
  console.log(`🚄 Fetching real ÖBB data: ${fromStation} → ${toStation}`);
  
  try {
    let fromId, toId;
    
    if (fromStation === 'St. Pölten' && toStation === 'Linz') {
      fromId = '8100008'; // St. Pölten Hbf
      toId = '8100013';   // Linz/Donau Hbf
    } else {
      fromId = '8100013'; // Linz/Donau Hbf
      toId = '8100008';   // St. Pölten Hbf
    }
    
    const apiUrl = `https://oebb.macistry.com/api/journeys?from=${fromId}&to=${toId}`;
    console.log(`🌐 ÖBB Transport REST API: ${apiUrl}`);
    
    const response = await axios.get(apiUrl, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: 15000
    });
    
    console.log(`📨 API response: ${response.data ? JSON.stringify(response.data).length : 0} chars`);
    
    if (response.data && response.data.journeys) {
      const trains = parseTransportRestData(response.data.journeys);
      if (trains && trains.length > 0) {
        console.log(`✅ Successfully parsed ${trains.length} real trains`);
        return trains;
      }
    }
    
    throw new Error('No journey data found in API response');
    
  } catch (error) {
    console.error(`❌ ÖBB Transport REST API failed: ${error.message}`);
    throw error;
  } finally {
    isScrapingInProgress = false;
  }
}

function parseTransportRestData(journeys) {
  try {
    console.log(`🔍 Parsing ${journeys.length} journeys from Transport REST API`);
    
    const trains = [];
    
    for (const journey of journeys) {
      if (!journey.legs || journey.legs.length === 0) continue;
      
      const leg = journey.legs[0]; // First leg is the direct train
      if (!leg.line || !leg.departure || !leg.arrival) continue;
      
      // Parse actual departure time (including delays)
      const actualDepartureDate = new Date(leg.departure);
      const plannedDepartureDate = new Date(leg.plannedDeparture || leg.departure);
      
      const departureTime = actualDepartureDate.toLocaleTimeString('de-DE', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Europe/Vienna'
      });
      
      const arrivalTime = new Date(leg.arrival).toLocaleTimeString('de-DE', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Europe/Vienna'
      });
      
      const delay = leg.departureDelay || 0;
      const status = delay > 0 ? (delay <= 5 ? 'slightly-delayed' : 'delayed') : 'on-time';
      
      const trainType = leg.line.productName || 'RJ';
      const trainNumber = leg.line.name || `${trainType} ???`;
      
      const platform = leg.departurePlatform || '?';
      
      trains.push({
        departure: departureTime,
        arrival: arrivalTime,
        trainType: trainType,
        trainNumber: trainNumber,
        delay: Math.floor(delay / 60), // Convert seconds to minutes
        status: status,
        platform: platform,
        actualDepartureTime: actualDepartureDate, // For sorting
        plannedDepartureTime: plannedDepartureDate
      });
      
      console.log(`✅ Parsed: ${trainNumber} planned:${plannedDepartureDate.toLocaleTimeString('de-DE', {hour:'2-digit',minute:'2-digit'})} actual:${departureTime} (${Math.floor(delay / 60)}min delay)`);
    }
    
    // Sort by actual departure time (planned + delay)
    trains.sort((a, b) => a.actualDepartureTime.getTime() - b.actualDepartureTime.getTime());
    
    // Remove sorting fields and return only first 3
    const sortedTrains = trains.slice(0, 3).map(train => {
      const { actualDepartureTime, plannedDepartureTime, ...cleanTrain } = train;
      return cleanTrain;
    });
    
    console.log(`📊 Sorted ${sortedTrains.length} trains by actual departure time`);
    
    return sortedTrains;
    
  } catch (error) {
    console.error('❌ Error parsing Transport REST data:', error);
    return [];
  }
}

function extractTrainData(html) {
  try {
    console.log('🔍 Extracting train data from HTML...');
    
    const $ = cheerio.load(html);
    const trains = [];
    
    // Method 1: Look for any tables or structured data
    $('table tr, .result, .journey, .connection, div[class*="result"]').each((index, element) => {
      if (trains.length >= 3) return false;
      
      const $element = $(element);
      const text = $element.text().trim();
      
      if (text && text.length > 10) {
        console.log(`📋 Element ${index}: "${text.substring(0, 100)}..."`);
        
        const train = parseTrainFromText(text);
        if (train) {
          trains.push(train);
          console.log(`✅ Parsed: ${train.trainNumber} ${train.departure}`);
        }
      }
    });
    
    // Method 2: Look in script tags for embedded data
    if (trains.length === 0) {
      console.log('📜 Searching script tags...');
      
      $('script').each((index, element) => {
        if (trains.length >= 3) return false;
        
        const scriptContent = $(element).html() || '';
        
        if (scriptContent.includes('RJ') || scriptContent.includes('WB') || 
            scriptContent.includes('departure') || scriptContent.includes('journey')) {
          
          console.log(`📜 Script ${index} has potential train data`);
          
          // Look for time patterns with train info nearby
          const lines = scriptContent.split('\\n');
          for (const line of lines) {
            if (trains.length >= 3) break;
            
            if (/\\d{1,2}:\\d{2}/.test(line) && (line.includes('RJ') || line.includes('WB'))) {
              console.log(`🕐 Script line: ${line.trim().substring(0, 100)}`);
              const train = parseTrainFromText(line);
              if (train) {
                trains.push(train);
                console.log(`✅ Script parsed: ${train.trainNumber} ${train.departure}`);
              }
            }
          }
        }
      });
    }
    
    // Method 3: Full text search as last resort
    if (trains.length === 0) {
      console.log('📄 Full text search...');
      
      const fullText = $.text();
      const lines = fullText.split('\\n');
      
      for (const line of lines.slice(0, 1000)) { // Limit to avoid too much processing
        if (trains.length >= 3) break;
        
        const trimmed = line.trim();
        if (trimmed.length > 15 && /\\d{1,2}:\\d{2}/.test(trimmed)) {
          const train = parseTrainFromText(trimmed);
          if (train) {
            trains.push(train);
            console.log(`✅ Text parsed: ${train.trainNumber} ${train.departure}`);
          }
        }
      }
    }
    
    return trains;
    
  } catch (error) {
    console.error('❌ Error extracting train data:', error);
    return [];
  }
}

function tryAlternativeMethods(html) {
  try {
    console.log('🔄 Trying alternative extraction methods...');
    
    const trains = [];
    
    // Method: Look for JSON-like structures
    const jsonPattern = /\\{[^{}]*"[^"]*"\\s*:\\s*[^{}]*\\}/g;
    const jsonMatches = html.match(jsonPattern);
    
    if (jsonMatches) {
      console.log(`📊 Found ${jsonMatches.length} potential JSON objects`);
      
      jsonMatches.slice(0, 10).forEach((match, index) => {
        if (trains.length >= 3) return;
        
        try {
          const obj = JSON.parse(match);
          if ((obj.time || obj.departure || obj.train) && trains.length < 3) {
            console.log(`✅ JSON ${index}: Found train object`);
            const train = parseTrainFromJSON(obj);
            if (train) {
              trains.push(train);
            }
          }
        } catch (e) {
          // Not valid JSON, skip
        }
      });
    }
    
    return trains;
    
  } catch (error) {
    console.error('❌ Alternative methods error:', error);
    return [];
  }
}

function parseTrainFromText(text) {
  try {
    const timeMatches = text.match(/\\b(\\d{1,2}:\\d{2})\\b/g);
    if (!timeMatches || timeMatches.length < 1) {
      return null;
    }
    
    const depTime = timeMatches[0];
    
    // Look for train patterns
    const trainPattern = /\\b(RJX?|ICE?|WB|NJ|REX|D|S|R)\\s*(\\d+)?/gi;
    const trainMatches = text.match(trainPattern);
    
    let trainType = 'RJ';
    let trainNumber = `RJ ${depTime.replace(':', '')}`;
    
    if (trainMatches && trainMatches.length > 0) {
      const match = trainMatches[0];
      trainType = extractTrainType(match);
      trainNumber = match.replace(/\\s+/g, ' ').trim();
    }
    
    // Look for delays
    const delayPattern = /(?:\\+|Vers|Verspätung|delay)\\s*(\\d+)/gi;
    const delayMatches = text.match(delayPattern);
    const delay = delayMatches ? parseInt(delayMatches[0].match(/\\d+/)[0]) : 0;
    
    // Calculate arrival time
    const [depHour, depMin] = depTime.split(':').map(Number);
    const journeyMinutes = trainType === 'WB' ? 68 : 71;
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
    const depTime = obj.departure || obj.time || obj.dep || '??:??';
    const trainName = obj.train || obj.line || obj.product || 'Train';
    const delay = parseInt(obj.delay || obj.delayMinutes || 0);
    
    if (depTime !== '??:??' && /\\d{1,2}:\\d{2}/.test(depTime)) {
      const trainType = extractTrainType(trainName);
      const status = delay > 0 ? (delay <= 5 ? 'slightly-delayed' : 'delayed') : 'on-time';
      
      const [depHour, depMin] = depTime.split(':').map(Number);
      const journeyMinutes = trainType === 'WB' ? 68 : 71;
      const totalMinutes = (depHour * 60 + depMin + journeyMinutes) % (24 * 60);
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

function getRealisticFallback(fromStation, toStation) {
  console.log(`🚂 Realistic ÖBB fallback: ${fromStation} → ${toStation}`);
  
  const now = new Date();
  const currentHour = now.getHours();
  const currentMinute = now.getMinutes();
  const totalMinutes = currentHour * 60 + currentMinute;
  
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

// API Endpoints
app.get('/trains/stpoelten-linz', async (req, res) => {
  console.log('🚄 API Request: St. Pölten → Linz');
  
  try {
    const trains = await fetchOebbTransportRest('St. Pölten', 'Linz');
    
    res.json({
      route: "St. Pölten → Linz",
      timestamp: new Date().toISOString(),
      trains: trains,
      source: 'oebb-transport-rest-v7',
      realTimeData: true,
      success: true
    });
    
  } catch (error) {
    console.error(`❌ Transport REST API failed: ${error.message}`);
    
    const fallbackData = getRealisticFallback('St. Pölten', 'Linz');
    
    res.json({
      route: "St. Pölten → Linz",
      timestamp: new Date().toISOString(),
      trains: fallbackData,
      source: 'realistic-fallback-v7',
      realTimeData: false,
      success: false,
      error: error.message
    });
  }
});

app.get('/trains/linz-stpoelten', async (req, res) => {
  console.log('🚄 API Request: Linz → St. Pölten');
  
  try {
    const trains = await fetchOebbTransportRest('Linz', 'St. Pölten');
    
    res.json({
      route: "Linz → St. Pölten",
      timestamp: new Date().toISOString(),
      trains: trains,
      source: 'oebb-transport-rest-v7',
      realTimeData: true,
      success: true
    });
    
  } catch (error) {
    console.error(`❌ Transport REST API failed: ${error.message}`);
    
    const fallbackData = getRealisticFallback('Linz', 'St. Pölten');
    
    res.json({
      route: "Linz → St. Pölten",
      timestamp: new Date().toISOString(),
      trains: fallbackData,
      source: 'realistic-fallback-v7',
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
    version: '7.0.0',
    scrapingInProgress: isScrapingInProgress,
    features: ['fixed-regex', 'webapp-urls', 'no-cache']
  });
});

app.get('/', (req, res) => {
  res.json({
    message: 'ÖBB Proxy v7.0 - Transport REST API (Real Data)',
    description: 'Uses real ÖBB Transport REST API for live train data',
    endpoints: [
      '/trains/stpoelten-linz',
      '/trains/linz-stpoelten',
      '/health'
    ],
    version: '7.0.0',
    fixes: ['Real ÖBB API integration', 'Live delay information', 'Accurate platforms'],
    features: ['Real-time data', 'Actual delays', 'Live departures', 'No caching']
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚄 ÖBB Proxy v7.0 running on port ${PORT}`);
  console.log('✅ Using real ÖBB Transport REST API');
  console.log('🌐 Live train data with delays');
  console.log('🔍 Real-time departures & arrivals');
  console.log('❌ No caching - always fresh data');
  console.log('\\n🚂 Ready to serve live trains!\\n');
});