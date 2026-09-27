function RunDigest() { return 1; }
function HandleEmail() { return 2; }
cron.schedule("@daily", RunDigest);
queue.process("emails", HandleEmail);
// queue.process("ghost", GhostHandler);
/* cron.schedule("@hourly", HiddenHandler); */
