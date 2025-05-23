// ================================================
// FILE: worker.js
// ================================================
import http from 'http';
import { supabase } from './supabaseClient.js';
import { processUser, needsScheduledUpdate, needsImmediateUpdate } from './processUser.js';
import { processTelegramUser } from './processTelegramUser.js';
import config from './config.js';

let isScheduledContentJobRunning = false;
let isImmediateContentCheckRunning = false;
let isTelegramJobRunning = false;
let isMidnightRefreshRunning = false;

let scheduledContentTimeoutId = null;
let immediateCheckTimeoutId = null;
let telegramJobTimeoutId = null;
let midnightRefreshTimeoutId = null;

const usersCurrentlyProcessingContent = new Set(); // Lock for processUser calls

const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (req.method === 'GET' && req.url === '/ping') {
        res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('pong');
    } else if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            scheduledContentJobRunning: isScheduledContentJobRunning,
            immediateContentCheckRunning: isImmediateContentCheckRunning,
            telegramJobRunning: isTelegramJobRunning,
            midnightRefreshRunning: isMidnightRefreshRunning,
            nextScheduledContentRunScheduled: scheduledContentTimeoutId !== null,
            nextImmediateCheckScheduled: immediateCheckTimeoutId !== null,
            nextTelegramRunScheduled: telegramJobTimeoutId !== null,
            nextMidnightRefreshScheduled: midnightRefreshTimeoutId !== null,
            usersProcessingContent: Array.from(usersCurrentlyProcessingContent),
        }));
    } else { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not Found'); }
});
server.listen(config.port, () => { console.log(`[HTTP Server] Listening on port ${config.port}`); });
server.on('error', (error) => { console.error('[HTTP Server] Server Error:', error); });


async function runScheduledContentCycle() {
    if (isScheduledContentJobRunning) {
        scheduleNextScheduledContentRun();
        return;
    }
    isScheduledContentJobRunning = true;
    // console.log(`\n============ [ScheduledContentJob ${new Date().toISOString()}] Starting Cycle ============`);

    try {
        const { data: users, error } = await supabase
            .from('user_preferences')
            .select('user_email, preferences, ispro, watchlist, sector, narrative, last_job, preference_update')
            .eq('ispro', true);

        if (error) {
            console.error(" -> Error fetching users for scheduled content:", error.message);
        } else if (users && users.length > 0) {
            for (const user of users) {
                 if (usersCurrentlyProcessingContent.has(user.user_email)) continue; // Skip if already processing
                 if (needsScheduledUpdate(user)) {
                      usersCurrentlyProcessingContent.add(user.user_email); // Lock
                      try { await processUser(user); }
                      catch (userError) { console.error(`!!! [ScheduledContentJob] Error processing ${user.user_email}:`, userError.message); }
                      finally { usersCurrentlyProcessingContent.delete(user.user_email); } // Unlock
                 }
            }
        }
    } catch (cycleError) {
        console.error(`!!! [ScheduledContentJob] Critical error during cycle:`, cycleError.message, cycleError.stack);
    } finally {
        // console.log(`============ [ScheduledContentJob ${new Date().toISOString()}] Cycle Ended ============`);
        isScheduledContentJobRunning = false;
        scheduleNextScheduledContentRun();
    }
}

function scheduleNextScheduledContentRun() {
    if (scheduledContentTimeoutId) clearTimeout(scheduledContentTimeoutId);
    scheduledContentTimeoutId = setTimeout(runScheduledContentCycle, config.jobIntervalMs);
}


async function runImmediateCheckCycle() {
    if (isImmediateContentCheckRunning) {
        scheduleNextImmediateCheck();
        return;
    }
    isImmediateContentCheckRunning = true;

    try {
        const { data: users, error } = await supabase
            .from('user_preferences')
            .select('user_email, preferences, ispro, watchlist, sector, narrative, last_job, preference_update')
            .eq('ispro', true);

        if (error) {
            console.error(" -> Error fetching users for immediate check:", error.message);
        } else if (users && users.length > 0) {
             for (const user of users) {
                 if (usersCurrentlyProcessingContent.has(user.user_email)) continue; // Skip if already processing
                 if (needsImmediateUpdate(user)) {
                      // console.log(` -> [ImmediateCheck] Triggering update for ${user.user_email}`);
                      usersCurrentlyProcessingContent.add(user.user_email); // Lock
                      try { await processUser(user); }
                      catch (userError) { console.error(`!!! [ImmediateCheck] Error processing ${user.user_email}:`, userError.message); }
                      finally { usersCurrentlyProcessingContent.delete(user.user_email); } // Unlock
                 }
             }
        }
    } catch (cycleError) {
        console.error(`!!! [ImmediateCheck] Critical error during cycle:`, cycleError.message, cycleError.stack);
    } finally {
        isImmediateContentCheckRunning = false;
        scheduleNextImmediateCheck();
    }
}

function scheduleNextImmediateCheck() {
    if (immediateCheckTimeoutId) clearTimeout(immediateCheckTimeoutId);
    immediateCheckTimeoutId = setTimeout(runImmediateCheckCycle, config.instantCheckIntervalMs);
}


async function runTelegramJobCycle() {
     if (isTelegramJobRunning) {
         scheduleNextTelegramRun();
         return;
     }
     isTelegramJobRunning = true;

     try {
         const { data: users, error } = await supabase
             .from('user_preferences')
             .select('user_email, telegramid, watchlist, sector, narrative, tele_last_sent, ispro, last_job')
             .eq('ispro', true)
             .not('telegramid', 'is', null);

         if (error) {
             console.error(" -> Error fetching users for Telegram:", error.message);
         } else if (users && users.length > 0) {
             for (const user of users) { // Process sequentially
                 try { await processTelegramUser(user, usersCurrentlyProcessingContent); } // Pass lock Set
                 catch (userError) { console.error(`!!! [TelegramJob] Error processing Telegram for ${user.user_email}:`, userError.message); }
             }
         }
     } catch (cycleError) {
         console.error(`!!! [TelegramJob] Critical error during cycle:`, cycleError.message, cycleError.stack);
     } finally {
         isTelegramJobRunning = false;
         scheduleNextTelegramRun();
     }
 }

 function scheduleNextTelegramRun() {
     if (telegramJobTimeoutId) clearTimeout(telegramJobTimeoutId);
     telegramJobTimeoutId = setTimeout(runTelegramJobCycle, config.telegramJobIntervalMs);
 }


async function runMidnightRefresh() {
    if (isMidnightRefreshRunning) {
        scheduleNextMidnightRefresh(); // Reschedule anyway
        return;
    }
    isMidnightRefreshRunning = true;
    console.log(`\n============ [MidnightRefresh ${new Date().toISOString()}] Starting Cycle ============`);

    try {
        const { data: users, error } = await supabase
            .from('user_preferences')
            .select('user_email, preferences, ispro, watchlist, sector, narrative, last_job, preference_update') // Select all needed by processUser
            .eq('ispro', true);

        if (error) {
            console.error(" -> Error fetching users for midnight refresh:", error.message);
        } else if (users && users.length > 0) {
             console.log(` -> Found ${users.length} Pro users for midnight refresh.`);
             // Use Promise.allSettled for concurrency but track locks
             const processingPromises = users.map(async (user) => {
                  if (usersCurrentlyProcessingContent.has(user.user_email)) {
                       console.log(` -> [MidnightRefresh] Skipping ${user.user_email}, already processing.`);
                       return; // Skip if locked
                  }
                  usersCurrentlyProcessingContent.add(user.user_email); // Lock before async call
                  try {
                       await processUser(user, true); // Force run
                  } catch (userError) {
                       console.error(`!!! [MidnightRefresh] Error processing ${user.user_email}:`, userError.message);
                  } finally {
                       usersCurrentlyProcessingContent.delete(user.user_email); // Unlock in finally
                  }
             });
             await Promise.allSettled(processingPromises);
             console.log(` -> Finished midnight refresh processing loop.`);
        } else {
             console.log(" -> No Pro users found for midnight refresh.");
        }
    } catch (cycleError) {
        console.error(`!!! [MidnightRefresh] Critical error during cycle:`, cycleError.message, cycleError.stack);
    } finally {
        console.log(`============ [MidnightRefresh ${new Date().toISOString()}] Cycle Ended ============`);
        isMidnightRefreshRunning = false;
        scheduleNextMidnightRefresh();
    }
}

function scheduleNextMidnightRefresh() {
    if (midnightRefreshTimeoutId) clearTimeout(midnightRefreshTimeoutId);

    const now = new Date();
    const londonNow = new Date(now.toLocaleString('en-US', { timeZone: config.londonTimezone }));

    const londonTomorrowMidnight = new Date(londonNow);
    londonTomorrowMidnight.setDate(londonTomorrowMidnight.getDate() + 1);
    londonTomorrowMidnight.setHours(0, 0, 0, 0);

    // Convert London midnight back to the server's local time to calculate the delay
    // Note: This assumes the server's clock is reasonably accurate.
    // Getting the *actual* UTC time corresponding to London midnight:
    const tomorrowMidnightUTC = new Date(
        Date.UTC(
            londonTomorrowMidnight.getFullYear(),
            londonTomorrowMidnight.getMonth(),
            londonTomorrowMidnight.getDate(),
            0, 0, 0
        )
    );
    // Need to adjust based on London's offset *at that future time* (DST matters)
    // A simpler way is to get tomorrow midnight in London string, then parse
    const londonTomorrowMidnightStr = `${londonTomorrowMidnight.getFullYear()}-${String(londonTomorrowMidnight.getMonth() + 1).padStart(2, '0')}-${String(londonTomorrowMidnight.getDate()).padStart(2, '0')}T00:00:00`;

    // Use Date.parse on a string known to be in London time (requires robust parsing or library)
    // *Simplification:* Calculate delay based on current offset idea. This is less robust across DST changes.
    // A better approach uses a library like date-fns-tz or luxon.
    // Sticking to basic JS for now:

    const msUntilMidnight = londonTomorrowMidnight.getTime() - londonNow.getTime();

    console.log(`[Scheduler] Scheduling next Midnight Refresh in ${Math.round(msUntilMidnight / 1000 / 60)} minutes (at ${londonTomorrowMidnight.toLocaleString()})`);
    midnightRefreshTimeoutId = setTimeout(runMidnightRefresh, msUntilMidnight);
}


console.log("Starting DegenTimes Worker Process...");
console.log(` - Scheduled Content Job Interval: ${config.jobIntervalMs / 1000}s (${config.jobRefreshHours} hours)`);
console.log(` - Immediate Content Check Interval: ${config.instantCheckIntervalMs / 1000}s`);
console.log(` - Telegram Job Interval: ${config.telegramJobIntervalMs / 1000}s`);
console.log(` - Telegram Send Cooldown: ${config.telegramSendIntervalHours} hours`);
console.log(` - Midnight Refresh Timezone: ${config.londonTimezone}`);

runScheduledContentCycle();
runImmediateCheckCycle();
runTelegramJobCycle();
scheduleNextMidnightRefresh(); // Initial schedule for midnight

function shutdown(signal) {
    console.log(`[Process] ${signal} signal received. Shutting down gracefully.`);
    server.close(() => { console.log('[HTTP Server] Closed.'); });
    if (scheduledContentTimeoutId) clearTimeout(scheduledContentTimeoutId);
    if (immediateCheckTimeoutId) clearTimeout(immediateCheckTimeoutId);
    if (telegramJobTimeoutId) clearTimeout(telegramJobTimeoutId);
    if (midnightRefreshTimeoutId) clearTimeout(midnightRefreshTimeoutId);
    setTimeout(() => process.exit(0), 500);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
