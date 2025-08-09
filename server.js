const express = require('express');
const cors = require('cors');
const oebb = require('oebb-api');

const app = express();
app.use(cors());

// Cache settings
const CACHE_DURATION = parseInt(process.env.CACHE_DURATION || '120000'); // 2 minutes for live data
const cache = {
  stpLinz: { data: null, timestamp: 0 },
  linzStp: { data: null, timestamp: 0 },
  stations: {}
};

console.log('Starting ÖBB API Proxy with mymro/oebb-api...');

// Get station ID (cached)
async function getStationId(stationName) {
  if (cache.stations[stationName]) {
    return cache.stations[stationName];
  }
  
  try {
    console.log(`Searching for station: ${stationName}`);
    const stations = await oebb.searchStationsNew(stationName);
    
    if (stations && stations.length > 0) {
      const stationId = stations[0].number;
      console.log(`Found station ${stationName}: ID ${stationId}`);
      cache.stations[stationName] = stationId;
      return stationId;
    } else {
      throw new Error(`Station not found: ${stationName}`);
    }
  } catch (error) {
    console.error(`Error finding station ${stationName}:`, error);
    throw error;
  }
}

// Get real-time departures
async function getRealDepartures(fromStation, toStation) {
  try {
    console.log(`Getting departures from ${fromStation} to ${toStation}`);
    
    const fromId = await getStationId(fromStation);
    const toId = await getStationId(toStation);
    
    const options = oebb.getStationBoardDataOptions();
    options.evaId = fromId;
    options.dirInput = toId; // Filter for trains going to destination
    options.maxJourneys = 10; // Get more trains to filter
    
    console.log(`Fetching station board data for station ${fromId} towards ${toId}`);
    const stationBoard = await oebb.getStationBoardData(options);
    
    console.log('Raw ÖBB API response structure:', JSON.stringify(stationBoard, null, 2));
    
    if (!stationBoard || !stationBoard.journey) {
      throw new Error('No journey data received from ÖBB API');
    }
    
    // Transform the data to our format
    const trains = stationBoard.journey.slice(0, 3).map(journey => {
      
      // Extract departure time
      const depTime = journey.date + ' ' + journey.time;
      const departure = new Date(depTime);
      
      // Calculate arrival (rough estimate + 71 minutes for St.P-Linz)
      const arrival = new Date(departure.getTime() + 71 * 60000);
      
      // Format times
      const depTimeStr = departure.toLocaleTimeString('de-AT', { 
        hour: '2-digit', 
        minute: '2-digit',
        hour12: false
      });
      const arrTimeStr = arrival.toLocaleTimeString('de-AT', { 
        hour: '2-digit', 
        minute: '2-digit',
        hour12: false
      });
      
      // Extract train info
      const trainName = journey.pr || journey.name || 'Unknown';
      const trainType = getTrainType(trainName);
      
      // Extract delay info
      let delay = 0;
      let status = 'on-time';
      
      if (journey.rt && journey.rt.dlm) {
        delay = parseInt(journey.rt.dlm) || 0;
        if (delay > 0) {
          status = delay <= 5 ? 'slightly-delayed' : 'delayed';
        }
      }
      
      console.log(`Parsed train: ${trainName} (${trainType}) ${depTimeStr}->${arrTimeStr}, delay: ${delay}min, status: ${status}`);
      
      return {
        departure: depTimeStr,
        arrival: arrTimeStr,
        trainType: trainType,
        trainNumber: trainName,
        delay: delay,
        status: status,
        platform: journey.platform || '?'
      };
    });
    
    return trains;
    
  } catch (error) {
    console.error('Error getting real departures:', error);
    throw error;
  }
}

function getTrainType(trainName) {
  if (!trainName) return 'Train';
  
  const name = trainName.toUpperCase();
  
  // Check for specific train types
  if (name.includes('RJX') || name.includes('RAILJET XPRESS')) return 'RJX';
  if (name.includes('RJ') || name.includes('RAILJET')) return 'RJ';
  if (name.includes('ICE')) return 'ICE';
  if (name.includes('IC ') || name.startsWith('IC')) return 'IC';
  if (name.includes('WESTBAHN') || name.includes('WB')) return 'WB';
  if (name.includes('NIGHTJET') || name.includes('NJ')) return 'NJ';
  if (name.includes('REX')) return 'REX';
  if (name.includes('D ') || name.startsWith('D ')) return 'D';
  if (name.includes('S ') || name.startsWith('S')) return 'S';
  if (name.includes('R ') || name.startsWith('R ')) return 'R';
  
  return 'Train';
}

// Enhanced fallback data - only use if API completely fails
function getFallbackData(route) {
  console.log('Using fallback data for:', route);
  
  const currentTime = new Date();
  const currentHour = currentTime.getHours();
  const currentMinute = currentTime.getMinutes();
  
  // Round to next quarter hour
  let nextMinute = Math.ceil(currentMinute / 15) * 15;
  let nextHour = currentHour;
  
  if (nextMinute >= 60) {
    nextHour = (nextHour + 1) % 24;
    nextMinute = 0;
  }
  
  const trains = [];
  const baseTrains = route === 'stpoelten-linz' ? 
    [
      { type: 'RJ', offset: 0, duration: 71 },
      { type: 'WB', offset: 30, duration: 68 },
      { type: 'RJX', offset: 60, duration: 65 }
    ] : [
      { type: 'RJ', offset: 0, duration: 71 },
      { type: 'IC', offset: 35, duration: 73 },
      { type: 'WB', offset: 65, duration: 68 }
    ];
  
  for (let i = 0; i < 3; i++) {
    const trainInfo = baseTrains[i];
    
    const depMinutes = (nextHour * 60 + nextMinute + trainInfo.offset) % (24 * 60);
    const depHour = Math.floor(depMinutes / 60);
    const depMin = depMinutes % 60;
    
    const arrMinutes = (depMinutes + trainInfo.duration) % (24 * 60);
    const arrHour = Math.floor(arrMinutes / 60);
    const arrMin = arrMinutes % 60;
    
    const trainNum = trainInfo.type === 'WB' ? 
      `WB ${8640 + i * 2}` : 
      `${trainInfo.type} ${540 + i * 2}`;
    
    const delay = Math.random() > 0.8 ? Math.floor(Math.random() * 8) : 0;
    const status = delay === 0 ? 'scheduled' : 
                  delay <= 3 ? 'slightly-delayed' : 'delayed';
    
    trains.push({
      departure: `${depHour.toString().padStart(2, '0')}:${depMin.toString().padStart(2, '0')}`,
      arrival: `${arrHour.toString().padStart(2, '0')}:${arrMin.toString().padStart(2, '0')}`,
      trainType: trainInfo.type,
      trainNumber: trainNum,
      delay: delay,
      status: status,
      platform: route === 'stpoelten-linz' ? '2' : '1'
    });
  }
  
  return trains;
}

async function getJourneys(fromStation, toStation, cacheKey) {
  const now = Date.now();
  
  // Check cache (shorter cache for real-time data)
  if (cache[cacheKey] && cache[cacheKey].data && 
      now - cache[cacheKey].timestamp < CACHE_DURATION) {
    console.log('Returning cached data for', cacheKey);
    return { trains: cache[cacheKey].data, source: 'cache' };
  }
  
  try {
    console.log(`Fetching fresh real-time data for ${cacheKey}`);
    const trains = await getRealDepartures(fromStation, toStation);
    
    // Update cache
    cache[cacheKey] = {
      data: trains,
      timestamp: now
    };
    
    return { trains: trains, source: 'live-api' };
    
  } catch (error) {
    console.error(`Error fetching live data for ${cacheKey}:`, error);
    
    // Return cached data if available, otherwise fallback
    if (cache[cacheKey] && cache[cacheKey].data) {
      console.log('Returning stale cached data due to error');
      return { trains: cache[cacheKey].data, source: 'stale-cache' };
    }
    
    console.log('Using fallback data due to API error');
    return { trains: getFallbackData(cacheKey), source: 'fallback' };
  }
}

app.get('/trains/stpoelten-linz', async (req, res) => {
  try {
    const result = await getJourneys('St. Pölten', 'Linz', 'stpLinz');
    
    res.json({
      route: "St. Pölten → Linz",
      timestamp: new Date().toISOString(),
      trains: result.trains,
      source: result.source,
      realTimeData: result.source === 'live-api'
    });
  } catch (error) {
    console.error('Route handler error:', error);
    res.status(500).json({
      error: true,
      message: 'Failed to fetch train data',
      trains: getFallbackData('stpoelten-linz'),
      source: 'error-fallback'
    });
  }
});

app.get('/trains/linz-stpoelten', async (req, res) => {
  try {
    const result = await getJourneys('Linz', 'St. Pölten', 'linzStp');
    
    res.json({
      route: "Linz → St. Pölten",
      timestamp: new Date().toISOString(),
      trains: result.trains,
      source: result.source,
      realTimeData: result.source === 'live-api'
    });
  } catch (error) {
    console.error('Route handler error:', error);
    res.status(500).json({
      error: true,
      message: 'Failed to fetch train data',
      trains: getFallbackData('linz-stpoelten'),
      source: 'error-fallback'
    });
  }
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '2.5.0',
    apiProvider: 'mymro/oebb-api'
  });
});

app.get('/', (req, res) => {
  res.json({
    message: 'ÖBB API Proxy - Real-time Data via mymro/oebb-api',
    endpoints: [
      '/trains/stpoelten-linz',
      '/trains/linz-stpoelten',
      '/health',
      '/debug/cache'
    ],
    features: [
      'Real-time departures',
      'Live delay information', 
      'Multiple train types (RJ, RJX, WB, IC, etc.)',
      'Fallback data if API fails'
    ]
  });
});

app.get('/debug/cache', (req, res) => {
  res.json({
    cache: {
      stpLinz: {
        hasData: !!cache.stpLinz.data,
        age: cache.stpLinz.timestamp ? Date.now() - cache.stpLinz.timestamp : 'never',
        trainCount: cache.stpLinz.data ? cache.stpLinz.data.length : 0
      },
      linzStp: {
        hasData: !!cache.linzStp.data,
        age: cache.linzStp.timestamp ? Date.now() - cache.linzStp.timestamp : 'never',
        trainCount: cache.linzStp.data ? cache.linzStp.data.length : 0
      },
      stations: Object.keys(cache.stations).map(name => ({
        name,
        id: cache.stations[name]
      }))
    },
    config: {
      cacheDuration: CACHE_DURATION,
      apiProvider: 'mymro/oebb-api'
    }
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ÖBB API Proxy server running on port ${PORT}`);
  console.log('Using mymro/oebb-api for real-time ÖBB data');
  console.log('Available endpoints:');
  console.log('  /trains/stpoelten-linz  - Live departures St.P → Linz');
  console.log('  /trains/linz-stpoelten  - Live departures Linz → St.P');
  console.log('  /health                 - Service health check');
  console.log('  /debug/cache           - Cache and debug info');
});