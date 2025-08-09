const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
app.use(cors());

console.log('🚄 Starting ÖBB Web Scraper Proxy...');

// NO CACHE - Always fresh data as requested
let isScrapingInProgress = false;

async function scrapeOebbWebsite(fromStation, toStation) {
  if (isScrapingInProgress) {
    throw new Error('Scraping already in progress, please wait');
  }
  
  isScrapingInProgress = true;
  console.log(`🔍 Scraping ÖBB website: ${fromStation} → ${toStation}`);
  
  try {
    // Method 1: Try ÖBB's simpler mobile interface
    const mobileData = await tryMobileScraping(fromStation, toStation);
    if (mobileData && mobileData.length > 0) {
      console.log(`✅ Got ${mobileData.length} trains from mobile interface`);
      return mobileData;
    }
    
    // Method 2: Try ÖBB's API endpoints directly
    const apiData = await tryDirectApiCalls(fromStation, toStation);
    if (apiData && apiData.length > 0) {
      console.log(`✅ Got ${apiData.length} trains from direct API`);
      return apiData;
    }
    
    // Method 3: Try parsing the main website
    const webData = await tryWebsiteScraping(fromStation, toStation);
    if (webData && webData.length > 0) {
      console.log(`✅ Got ${webData.length} trains from website scraping`);
      return webData;
    }
    
    throw new Error('All scraping methods failed');
    
  } finally {
    isScrapingInProgress = false;
  }
}

async function tryMobileScraping(fromStation, toStation) {
  try {
    console.log('📱 Trying mobile interface...');
    
    // ÖBB mobile URLs are simpler to parse
    const stationMapping = {
      'St. Pölten': '8103002',
      'Linz': '8100009'
    };
    
    const fromId = stationMapping[fromStation];
    const toId = stationMapping[toStation];
    
    if (!fromId || !toId) {
      throw new Error('Station mapping not found');
    }
    
    // Try ÖBB's mobile query endpoint
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0].replace(/-/g, '.');
    const timeStr = now.toTimeString().substring(0, 5);
    
    const url = `https://fahrplan.oebb.at/bin/query.exe/dn?n=1&i=${fromId}&Z=${toId}&d=${dateStr}&t=${timeStr}&start=1`;
    
    console.log(`🔗 Trying URL: ${url}`);
    
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'de-AT,de;q=0.9,en;q=0.8'
      },
      timeout: 15000
    });
    
    if (response.data && response.data.includes('journey')) {
      console.log('📄 Got HTML response, parsing...');
      return parseMobileHtml(response.data);
    }
    
    throw new Error('No journey data in mobile response');
    
  } catch (error) {
    console.log(`❌ Mobile scraping failed: ${error.message}`);
    throw error;
  }
}

async function tryDirectApiCalls(fromStation, toStation) {
  try {
    console.log('🔗 Trying direct API calls...');
    
    // Try the HAFAS mgate endpoint with proper parameters
    const stationIds = {
      'St. Pölten': '008103002',
      'Linz': '008100009'
    };
    
    const fromId = stationIds[fromStation];
    const toId = stationIds[toStation];
    
    const now = new Date();
    const requestData = {
      lang: 'de',
      svcReqL: [{
        cfg: { polyEnc: 'GPA', rtMode: 'HYBRID' },
        meth: 'TripSearch',
        req: {
          depLocL: [{ lid: `A=1@L=${fromId}@` }],
          arrLocL: [{ lid: `A=1@L=${toId}@` }],
          outDate: now.toISOString().split('T')[0].replace(/-/g, ''),
          outTime: now.toTimeString().substring(0, 5).replace(':', ''),
          jnyFltrL: [{ type: 'PROD', mode: 'INC', value: '1023' }],
          numF: 3,
          getPasslist: false,
          getPolyline: false
        }
      }],
      client: { id: 'OEBB', type: 'WEB', name: 'webapp' },
      ver: '1.16',
      auth: { type: 'AID', aid: 'OWDL4fE4ixNiPBBm' }
    };
    
    console.log('📡 Making HAFAS API call...');
    
    const response = await axios.post('https://fahrplan.oebb.at/bin/mgate.exe', requestData, {
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://fahrplan.oebb.at/',
        'Accept': 'application/json'
      },
      timeout: 15000
    });
    
    if (response.data && response.data.svcResL) {
      console.log('📊 Got HAFAS response, parsing...');
      return parseHafasResponse(response.data);
    }
    
    throw new Error('Invalid HAFAS response structure');
    
  } catch (error) {
    console.log(`❌ Direct API failed: ${error.message}`);
    throw error;
  }
}

async function tryWebsiteScraping(fromStation, toStation) {
  try {
    console.log('🌐 Trying website scraping...');
    
    // Build the URL similar to your example
    const baseUrl = 'https://fahrplan.oebb.at/webapp/';
    const fromEncoded = fromStation === 'St. Pölten' ? 
      'A%3D1%40O%3DSt.P%C3%B6lten%20Hbf%40X%3D15623800%40Y%3D48208331%40U%3D81%40L%3D008100008%40B%3D1%40p%3D1275041666%40' :
      'A%3D1%40O%3DLinz%2FDonau%20Hbf%40X%3D14291814%40Y%3D48290150%40U%3D81%40L%3D008100013%40B%3D1%40p%3D1275041666%40';
    
    const toEncoded = toStation === 'Linz' ? 
      'A%3D1%40O%3DLinz%2FDonau%20Hbf%40X%3D14291814%40Y%3D48290150%40U%3D81%40L%3D008100013%40B%3D1%40p%3D1275041666%40' :
      'A%3D1%40O%3DSt.P%C3%B6lten%20Hbf%40X%3D15623800%40Y%3D48208331%40U%3D81%40L%3D008100008%40B%3D1%40p%3D1275041666%40';
    
    const now = new Date();
    const dateStr = now.toLocaleDateString('de-AT').replace(/\\//g, '.');
    const timeStr = now.toTimeString().substring(0, 8);
    
    const url = `${baseUrl}?context=TP&SID=${fromEncoded}&ZID=${toEncoded}&date=${dateStr}&time=${timeStr}&timeSel=1&returnTimeSel=1&journeyProducts=7167&start=1`;
    
    console.log(`🔗 Trying website URL...`);
    
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'de-AT,de;q=0.9,en;q=0.8'
      },
      timeout: 20000
    });
    
    if (response.data) {
      console.log('📄 Got website response, parsing...');
      return parseWebsiteHtml(response.data);
    }
    
    throw new Error('No website response data');
    
  } catch (error) {
    console.log(`❌ Website scraping failed: ${error.message}`);
    throw error;
  }
}

function parseMobileHtml(html) {
  try {
    const $ = cheerio.load(html);
    const trains = [];
    
    // Look for journey/connection elements in mobile interface
    $('tr.journey, tr.connection, .connection-row').each((i, element) => {
      if (i >= 3) return false; // Limit to 3 trains
      
      const $row = $(element);
      
      // Try to extract departure time
      const depTime = $row.find('.time, .dep-time, td:first-child').first().text().trim();
      
      // Try to extract train type/number
      const trainInfo = $row.find('.train, .product, .line').first().text().trim();
      
      // Try to extract delay
      const delayElement = $row.find('.delay, .rt-info, .realtime');
      const delayText = delayElement.text().trim();
      const delay = delayText ? parseInt(delayText.replace(/[^0-9]/g, '')) || 0 : 0;
      
      if (depTime && depTime.match(/\\d{1,2}:\\d{2}/)) {
        // Calculate arrival time (approximate)
        const [depHour, depMin] = depTime.split(':').map(Number);
        const arrivalMinutes = (depHour * 60 + depMin + 71) % (24 * 60); // 71 min journey
        const arrHour = Math.floor(arrivalMinutes / 60);
        const arrMin = arrivalMinutes % 60;
        const arrTime = `${arrHour.toString().padStart(2, '0')}:${arrMin.toString().padStart(2, '0')}`;
        
        const trainType = extractTrainType(trainInfo);
        const status = delay > 0 ? (delay <= 5 ? 'slightly-delayed' : 'delayed') : 'on-time';
        
        trains.push({
          departure: depTime,
          arrival: arrTime,
          trainType: trainType,
          trainNumber: trainInfo || `${trainType} ${depTime.replace(':', '')}`,
          delay: delay,
          status: status,
          platform: '?'
        });
        
        console.log(`✅ Parsed train: ${trainInfo} ${depTime} (${delay}min delay)`);
      }
    });
    
    return trains;
    
  } catch (error) {
    console.error('Error parsing mobile HTML:', error);
    return [];
  }
}

function parseHafasResponse(data) {
  try {
    const trains = [];
    
    if (data.svcResL && data.svcResL[0] && data.svcResL[0].res && data.svcResL[0].res.outConL) {
      const journeys = data.svcResL[0].res.outConL.slice(0, 3);
      
      for (const journey of journeys) {
        if (journey.secL && journey.secL.length > 0) {
          const firstSection = journey.secL[0];
          
          // Extract departure info
          const depTime = firstSection.dep ? formatHafasTime(firstSection.dep.dTimeS) : '??:??';
          const arrTime = firstSection.arr ? formatHafasTime(firstSection.arr.aTimeS) : '??:??';
          
          // Extract train info from journey products
          const prodL = data.svcResL[0].res.common.prodL;
          const product = prodL[firstSection.dep.prodX] || {};
          const trainName = product.name || 'Train';
          const trainType = extractTrainType(trainName);
          
          // Extract delay
          const depDelay = firstSection.dep.dDelay ? firstSection.dep.dDelay / 60 : 0;
          const delay = Math.round(depDelay);
          const status = delay > 0 ? (delay <= 5 ? 'slightly-delayed' : 'delayed') : 'on-time';
          
          trains.push({
            departure: depTime,
            arrival: arrTime,
            trainType: trainType,
            trainNumber: trainName,
            delay: delay,
            status: status,
            platform: firstSection.dep.dPlatfS || '?'
          });
          
          console.log(`✅ Parsed HAFAS train: ${trainName} ${depTime} (${delay}min delay)`);
        }
      }
    }
    
    return trains;
    
  } catch (error) {
    console.error('Error parsing HAFAS response:', error);
    return [];
  }
}

function parseWebsiteHtml(html) {
  try {
    const $ = cheerio.load(html);
    const trains = [];
    
    // Look for various selectors that might contain train data
    const selectors = [
      '.journey-row',
      '.connection',
      '.trip-result',
      '[class*="journey"]',
      '[class*="connection"]',
      'tr[class*="result"]'
    ];
    
    for (const selector of selectors) {
      $(selector).each((i, element) => {
        if (i >= 3 || trains.length >= 3) return false;
        
        const $row = $(element);
        const text = $row.text();
        
        // Look for time patterns
        const timeMatches = text.match(/(\\d{1,2}:\\d{2})/g);
        if (timeMatches && timeMatches.length >= 2) {
          const depTime = timeMatches[0];
          const arrTime = timeMatches[1];
          
          // Look for train type patterns
          const trainMatch = text.match(/(RJ|RJX|ICE|IC|WB|D|REX|S|R)\\s*(\\d+)/);
          const trainType = trainMatch ? trainMatch[1] : 'Train';
          const trainNumber = trainMatch ? `${trainMatch[1]} ${trainMatch[2]}` : `${trainType} ${depTime.replace(':', '')}`;
          
          // Look for delay pattern
          const delayMatch = text.match(/(\\+|Vers|Delay)\\s*(\\d+)/i);
          const delay = delayMatch ? parseInt(delayMatch[2]) : 0;
          const status = delay > 0 ? (delay <= 5 ? 'slightly-delayed' : 'delayed') : 'on-time';
          
          trains.push({
            departure: depTime,
            arrival: arrTime,
            trainType: trainType,
            trainNumber: trainNumber,
            delay: delay,
            status: status,
            platform: '?'
          });
          
          console.log(`✅ Parsed website train: ${trainNumber} ${depTime} (${delay}min delay)`);
        }
      });
      
      if (trains.length > 0) break; // If we found trains with this selector, stop trying others
    }
    
    return trains;
    
  } catch (error) {
    console.error('Error parsing website HTML:', error);
    return [];
  }
}

function formatHafasTime(timeString) {
  if (!timeString || timeString.length < 4) return '??:??';
  
  try {
    const hour = timeString.substring(0, 2);
    const minute = timeString.substring(2, 4);
    return `${hour}:${minute}`;
  } catch (error) {
    return '??:??';
  }
}

function extractTrainType(trainName) {
  if (!trainName) return 'Train';
  
  const name = trainName.toUpperCase();
  
  if (name.includes('RJX')) return 'RJX';
  if (name.includes('RJ')) return 'RJ';
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

// Emergency fallback - only used if ALL scraping fails
function getEmergencyData(fromStation, toStation) {
  console.log('🆘 Using emergency fallback data');
  
  const now = new Date();
  const currentHour = now.getHours();
  const currentMinute = now.getMinutes();
  
  // Next departure in ~15 minutes
  let nextHour = currentHour;
  let nextMinute = currentMinute + 15;
  
  if (nextMinute >= 60) {
    nextHour = (nextHour + 1) % 24;
    nextMinute -= 60;
  }
  
  const trains = [];
  const trainTypes = ['RJ', 'WB', 'RJ'];
  
  for (let i = 0; i < 3; i++) {
    const depHour = (nextHour + Math.floor(i * 0.5)) % 24;
    const depMin = (nextMinute + (i * 30)) % 60;
    
    const depTime = `${depHour.toString().padStart(2, '0')}:${depMin.toString().padStart(2, '0')}`;
    
    const arrivalMinutes = (depHour * 60 + depMin + 71) % (24 * 60);
    const arrHour = Math.floor(arrivalMinutes / 60);
    const arrMin = arrivalMinutes % 60;
    const arrTime = `${arrHour.toString().padStart(2, '0')}:${arrMin.toString().padStart(2, '0')}`;
    
    const trainType = trainTypes[i];
    const trainNumber = `${trainType} ${540 + i * 2}`;
    const delay = Math.random() > 0.8 ? Math.floor(Math.random() * 8) : 0;
    const status = delay > 0 ? (delay <= 5 ? 'slightly-delayed' : 'delayed') : 'on-time';
    
    trains.push({
      departure: depTime,
      arrival: arrTime,
      trainType: trainType,
      trainNumber: trainNumber,
      delay: delay,
      status: status,
      platform: fromStation === 'St. Pölten' ? '2' : '1'
    });
  }
  
  return trains;
}

// Main endpoints
app.get('/trains/stpoelten-linz', async (req, res) => {
  console.log('🚄 Request: St. Pölten → Linz');
  
  try {
    const trains = await scrapeOebbWebsite('St. Pölten', 'Linz');
    
    if (trains && trains.length > 0) {
      res.json({
        route: "St. Pölten → Linz",
        timestamp: new Date().toISOString(),
        trains: trains,
        source: 'live-scraping',
        realTimeData: true
      });
    } else {
      throw new Error('No train data from scraping');
    }
    
  } catch (error) {
    console.error(`❌ Scraping failed: ${error.message}`);
    
    const emergencyData = getEmergencyData('St. Pölten', 'Linz');
    res.json({
      route: "St. Pölten → Linz",
      timestamp: new Date().toISOString(),
      trains: emergencyData,
      source: 'emergency-fallback',
      realTimeData: false,
      error: error.message
    });
  }
});

app.get('/trains/linz-stpoelten', async (req, res) => {
  console.log('🚄 Request: Linz → St. Pölten');
  
  try {
    const trains = await scrapeOebbWebsite('Linz', 'St. Pölten');
    
    if (trains && trains.length > 0) {
      res.json({
        route: "Linz → St. Pölten",
        timestamp: new Date().toISOString(),
        trains: trains,
        source: 'live-scraping',
        realTimeData: true
      });
    } else {
      throw new Error('No train data from scraping');
    }
    
  } catch (error) {
    console.error(`❌ Scraping failed: ${error.message}`);
    
    const emergencyData = getEmergencyData('Linz', 'St. Pölten');
    res.json({
      route: "Linz → St. Pölten",
      timestamp: new Date().toISOString(),
      trains: emergencyData,
      source: 'emergency-fallback',
      realTimeData: false,
      error: error.message
    });
  }
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '4.0.0',
    scrapingInProgress: isScrapingInProgress,
    features: ['web-scraping', 'no-cache', 'real-time-attempts']
  });
});

app.get('/', (req, res) => {
  res.json({
    message: 'ÖBB Web Scraper Proxy v4.0',
    description: 'Real-time train data via web scraping - NO CACHE',
    endpoints: [
      '/trains/stpoelten-linz  - Live St. Pölten → Linz',
      '/trains/linz-stpoelten  - Live Linz → St. Pölten',
      '/health                 - Service health'
    ],
    features: [
      '🔍 Multi-method web scraping',
      '📱 Mobile interface parsing', 
      '🔗 Direct HAFAS API calls',
      '🌐 Website HTML parsing',
      '❌ No caching - always fresh data',
      '⚡ Real-time delays and departures'
    ],
    methods: [
      '1. Mobile ÖBB interface scraping',
      '2. Direct HAFAS mgate.exe calls',  
      '3. Main website HTML parsing',
      '4. Emergency fallback only if all fail'
    ]
  });
});

app.get('/debug/status', (req, res) => {
  res.json({
    scrapingInProgress: isScrapingInProgress,
    timestamp: new Date().toISOString(),
    methods: [
      'Mobile interface scraping',
      'Direct HAFAS API calls',
      'Website HTML parsing'
    ],
    cachingDisabled: true,
    version: '4.0.0'
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🔍 ÖBB Web Scraper Proxy running on port ${PORT}`);
  console.log('📵 CACHING DISABLED - Always fresh data');
  console.log('🎯 Multi-method scraping approach:');
  console.log('   1️⃣  Mobile interface scraping');
  console.log('   2️⃣  Direct HAFAS API calls');
  console.log('   3️⃣  Website HTML parsing');
  console.log('   🆘 Emergency fallback if all fail');
  console.log('\\n🚄 Ready to scrape real ÖBB data!\\n');
});