const { Command } = require('commander');
const afr = require('./afr');

const program = new Command();

program
  .command('claim')
  .description('Produce a claim blob')
  .action(async () => {
    const claimCid = await afr.claim();
    console.log(`Claim CID: ${claimCid}`);
  });

program
  .command('verify --claim <blob>')
  .description('Verify a claim blob')
  .action(async (options) => {
    const claimBlob = options.blob;
    await afr.verifyClaim(claimBlob);
  });

// ...