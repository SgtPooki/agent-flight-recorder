const { execSync } = require('child_process');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const ipfsClient = require('ipfs-http-client');
const { createCar } = require('ipfs-car');

// ...

async function claim() {
  const ipfs = ipfsClient();
  const car = await createCar();
  const chainRoot = await getChainRoot();
  const signer = await getSigner();
  const artifactDigests = await getArtifactDigests();

  const claimBlob = {
    ipfsRoot: chainRoot,
    chainRoot,
    signer,
    artifactDigests,
  };

  const claimJson = JSON.stringify(claimBlob);
  const claimCid = await ipfs.add(claimJson);
  console.log(`Claim CID: ${claimCid.path}`);
  return claimCid.path;
}

async function verifyClaim(claimBlob) {
  const ipfs = ipfsClient();
  const claimJson = JSON.parse(claimBlob);
  const { ipfsRoot, chainRoot, signer, artifactDigests } = claimJson;

  // Verify chain validity
  const chainValid = await verifyChain(ipfsRoot);
  if (!chainValid) {
    console.log('Chain is not valid');
    return;
  }

  // Verify signature validity
  const signatureValid = await verifySignature(signer, chainRoot);
  if (!signatureValid) {
    console.log('Signature is not valid');
    return;
  }

  // Verify artifact match
  const artifactMatch = await verifyArtifacts(artifactDigests);
  if (!artifactMatch) {
    console.log('Artifacts do not match');
    return;
  }

  console.log('Claim is valid');
}

// ...

module.exports = {
  // ...
  claim,
  verifyClaim,
};