/* @flow */

const blockstack = require('blockstack');
const jsontokens = require('jsontokens')
const express = require('express')
const crypto = require('crypto')

import winston from 'winston'
import logger from 'winston'

import {
  gaiaConnect,
  gaiaUploadProfileAll,
  makeAssociationToken,
  getGaiaAddressFromProfile
} from './data';

import {
  getApplicationKeyInfo,
  getOwnerKeyInfo,
  extractAppKey
} from './keys';

import {
  nameLookup,
  makeProfileJWT,
  getPublicKeyFromPrivateKey,
  canonicalPrivateKey,
} from './utils';

import { 
  type GaiaHubConfig
} from 'blockstack';

export const SIGNIN_HEADER = '<html><head></head></body><h2>Blockstack CLI Sign-in</h2><br>'
export const SIGNIN_FMT_NAME = '<p><a href="{authRedirect}">{blockstackID}</a> ({idAddress})</p>'
export const SIGNIN_FMT_ID = '<p><a href="{authRedirect}">{idAddress}</a> (anonymous)</p>'
export const SIGNIN_FOOTER = '</body></html>'

export type NamedIdentityType = {
  name: string,
  idAddress: string,
  privateKey: string,
  index: number,
  profile: Object,
  profileUrl: string
};

// new ecdsa private key each time
const authTransitKey = crypto.randomBytes(32).toString('hex');
const authTransitPubkey = getPublicKeyFromPrivateKey(authTransitKey);

/*
 * Get the app private key
 */
function getAppPrivateKey(network: Object,
                          mnemonic: string,
                          id: NamedIdentityType,
                          appOrigin: string
): string {
  const appKeyInfo = getApplicationKeyInfo(network, mnemonic, id.idAddress, appOrigin, id.index);
  let appPrivateKey;
  try {
    const existingAppAddress = getGaiaAddressFromProfile(network, id.profile, appOrigin);
    appPrivateKey = extractAppKey(network, appKeyInfo, existingAppAddress);
  }
  catch (e) {
    appPrivateKey = extractAppKey(network, appKeyInfo);
  }

  return appPrivateKey;
}

/*
 * Make a sign-in link
 */
function makeSignInLink(network: Object,
                        authPort: number,
                        mnemonic: string,
                        authRequest: Object,
                        hubUrl: string,
                        id: NamedIdentityType) : string {
  
  const appOrigin = authRequest.domain_name;
  const appKeyInfo = getApplicationKeyInfo(network, mnemonic, id.idAddress, appOrigin, id.index);
  const appPrivateKey = getAppPrivateKey(network, mnemonic, id, appOrigin);

  const associationToken = makeAssociationToken(appPrivateKey, id.privateKey)
  const authResponseTmp = blockstack.makeAuthResponse(
    id.privateKey,
    {},
    id.name,
    { email: null, profileUrl: id.profileUrl },
    null,
    appPrivateKey,
    undefined,
    authRequest.public_keys[0],
    hubUrl,
    blockstack.config.network.blockstackAPIUrl,
    associationToken
  );

  // pass along some helpful data from the authRequest
  const authResponsePayload = jsontokens.decodeToken(authResponseTmp).payload;
  authResponsePayload.metadata = {
    id: id,
    profileUrl: id.profileUrl,
    appOrigin: appOrigin,
    redirect_uri: authRequest.redirect_uri,
    scopes: authRequest.scopes,
    salt: crypto.randomBytes(16).toString('hex'),
    // fill in more CLI-specific fields here
  };

  const tokenSigner = new jsontokens.TokenSigner('ES256k', id.privateKey);
  const authResponse = tokenSigner.sign(authResponsePayload)

  // encrypt the auth response in-flight, so a rogue program can't just curl it out
  const encryptedAuthResponseJSON = blockstack.encryptContent(
    authResponse, { publicKey: authTransitPubkey })
  const encryptedAuthResponse = { json: encryptedAuthResponseJSON }

  const encTokenSigner = new jsontokens.TokenSigner('ES256k', authTransitKey)
  const encAuthResponse = encTokenSigner.sign(encryptedAuthResponse)

  return blockstack.updateQueryStringParameter(
    `http://localhost:${authPort}/signin`, 'encAuthResponse', encAuthResponse);
}

/*
 * Make the sign-in page
 */
function makeAuthPage(network: Object,
                      authPort: number,
                      mnemonic: string,
                      hubUrl: string,
                      manifest: Object,
                      authRequest: Object,
                      ids: Array<NamedIdentityType>) : string {

  let signinBody = SIGNIN_HEADER;

  for (let i = 0; i < ids.length; i++) {
    let signinEntry
    if (ids[i].name) {
      signinEntry = SIGNIN_FMT_NAME
        .replace(/{authRedirect}/, makeSignInLink(
          network,
          authPort,
          mnemonic,
          authRequest,
          hubUrl,
          ids[i]))
        .replace(/{blockstackID}/, ids[i].name)
        .replace(/{idAddress}/, ids[i].idAddress);
    }
    else {
      signinEntry = SIGNIN_FMT_ID
        .replace(/{authRedirect}/, makeSignInLink(
          network,
          authPort,
          mnemonic,
          authRequest,
          hubUrl,
          ids[i]))
        .replace(/{idAddress}/, ids[i].idAddress);
    }

    signinBody = `${signinBody}${signinEntry}`;
  }

  signinBody = `${signinBody}${SIGNIN_FOOTER}`;
  return signinBody;
}


/*
 * Find all identity addresses that have names attached to them.
 * Fills in identities.
 */
function loadNamedIdentitiesLoop(network: Object, 
                                 mnemonic: string, 
                                 index: number, 
                                 identities: Array<NamedIdentityType>) {
  const ret = [];

  // 65536 is a ridiculously huge number
  if (index > 65536) {
    throw new Error('Too many names')
  }

  const keyInfo = getOwnerKeyInfo(network, mnemonic, index);
  return network.getNamesOwned(keyInfo.idAddress.slice(3))
    .then((nameList) => {
      if (nameList.length === 0) {
        // out of names 
        return identities;
      }
      for (let i = 0; i < nameList.length; i++) {
        identities.push({
          name: nameList[i],
          idAddress: keyInfo.idAddress,
          privateKey: keyInfo.privateKey,
          index: index,
          profile: {},
          profileUrl: ''
        });
      }
      return loadNamedIdentitiesLoop(network, mnemonic, index + 1, identities);
    });
}

/*
 * Load all named identities for a mnemonic.
 * Keep loading until we find an ID-address that does not have a name.
 */
export function loadNamedIdentities(network: Object, mnemonic: string) 
  : Promise<Array<NamedIdentityType>> {
  return loadNamedIdentitiesLoop(network, mnemonic, 0, []);
}


/*
 * Generate identity info for an unnamed ID
 */
function loadUnnamedIdentity(network: Object, mnemonic: string, index: number): NamedIdentityType {
  const keyInfo = getOwnerKeyInfo(network, mnemonic, index);
  const idInfo = {
    name: '',
    idAddress: keyInfo.idAddress,
    privateKey: keyInfo.privateKey,
    index: index,
    profile: {},
    profileUrl: ''
  };
  return idInfo;
}

/*
 * Send a JSON HTTP response
 */
function sendJSON(res: express.response, data: Object, statusCode: number) {
  res.writeHead(statusCode, {'Content-Type' : 'application/json'})
  res.write(JSON.stringify(data))
  res.end()
}


/*
 * Get all of a 12-word phrase's identities, profiles, and Gaia connections.
 * Returns a Promise to an Array of NamedIdentityType instances.
 *
 * NOTE: should be the *only* promise chain running!
 */
function getIdentityInfo(network: Object, mnemonic: string, appGaiaHub: string, profileGaiaHub: string) 
  : Promise<Array<NamedIdentityType>> {

  let identities = [];
  network.setCoerceMainnetAddress(true);    // for lookups in regtest
  
  // load up all of our identity addresses and profile URLs
  const identitiesPromise = loadNamedIdentities(network, mnemonic)
    .then((ids) => {
      const nameInfoPromises = [];
      for (let i = 0; i < ids.length; i++) {
        const nameInfoPromise = nameLookup(network, ids[i].name, true)
          .catch(() => null);

        nameInfoPromises.push(nameInfoPromise);
      }

      identities = ids;
      return Promise.all(nameInfoPromises);
    })
    .then((nameDatas) => {
      network.setCoerceMainnetAddress(false);
      nameDatas = nameDatas.filter((p) => p !== null && p !== undefined);

      for (let i = 0; i < nameDatas.length; i++) {
        if (nameDatas[i].hasOwnProperty('error') && nameDatas[i].error) {
          // no data for this name 
          identities[i].profileUrl = '';
        }
        else {
          identities[i].profileUrl = nameDatas[i].profileUrl;
          identities[i].profile = nameDatas[i].profile;
        }
      }

      const nextIndex = identities.length + 1

      // ignore identities with no data
      identities = identities.filter((id) => !!id.profileUrl);

      // add in the next non-named identity
      identities.push(loadUnnamedIdentity(network, mnemonic, nextIndex))
      return identities;
    })
    .catch((e) => {
      network.setCoerceMainnetAddress(false);
      throw e;
    });

  return identitiesPromise;
}


/*
 * Handle GET /auth?authRequest=...
 * If the authRequest is verifiable and well-formed, and if we can fetch the application
 * manifest, then we can render an auth page to the user.
 * Serves back the sign-in page on success.
 * Serves back an error page on error.
 * Returns a Promise that resolves to nothing.
 *
 * NOTE: should be the *only* promise chain running!
 */
export function handleAuth(network: Object,
                           mnemonic: string,
                           gaiaHubUrl: string,
                           profileGaiaHub: string,
                           port: number, 
                           req: express.request,
                           res: express.response
) : Promise<*> {

  const authToken = req.query.authRequest;
  if (!authToken) {
     return Promise.resolve().then(() => {
       sendJSON(res, { error: 'No authRequest given' }, 400);
     });
  }
 
  let errorMsg;
  let identities;
  return getIdentityInfo(network, mnemonic, gaiaHubUrl, profileGaiaHub)
    .then((ids) => {
      identities = ids;
      errorMsg = 'Unable to verify authentication token';
      return blockstack.verifyAuthRequest(authToken);
    })
    .then((valid) => {
      if (!valid) {
        errorMsg = 'Invalid authentication token: could not verify';
        throw new Error(errorMsg);
      }
      errorMsg = 'Unable to fetch app manifest';
      return blockstack.fetchAppManifest(authToken);
    })
    .then((appManifest) => {
      const decodedAuthToken = jsontokens.decodeToken(authToken);
      const decodedAuthPayload = decodedAuthToken.payload;
      if (!decodedAuthPayload) {
        errorMsg = 'Invalid authentication token: no payload';
        throw new Error(errorMsg);
      }

      // make sign-in page
      const authPage = makeAuthPage(
        network, port, mnemonic, gaiaHubUrl, appManifest, decodedAuthPayload, identities);

      res.writeHead(200, {'Content-Type': 'text/html', 'Content-Length': authPage.length});
      res.write(authPage);
      res.end();
      return;
    })
    .catch((e) => {
      if (!errorMsg) {
        errorMsg = e.message;
      }

      logger.error(e)
      logger.error(errorMsg)
      sendJSON(res, { error: `Unable to authenticate app request: ${errorMsg}` }, 400);
      return;
    });
}

/*
 * Update a named identity's profile with new app data, if necessary.
 * Indicates whether or not the profile was changed.
 */
function updateProfileApps(network: Object, 
                          id: NamedIdentityType, 
                          appOrigin: string, 
                          appGaiaConfig: GaiaHubConfig
): Promise<{ profile: Object, changed: boolean }> {

  let profile;
  let needProfileUpdate = false;

  // go get the profile from the profile URL in the id
  const profilePromise = nameLookup(network, id.name)
    .catch((e) => null)
      
  return profilePromise.then((profileData) => {
    if (profileData) {
      profile = profileData.profile;
    }

    if (!profile) {
      // instantiate 
      logger.debug(`Instantiating profile for ${id.name}`);
      needProfileUpdate = true;
      profile = {
        'type': '@Person',
        'account': [],
        'apps': {},
      };
    }

    // do we need to update the Gaia hub read URL in the profile?
    if (profile.apps === null || profile.apps === undefined) {
      needProfileUpdate = true;

      logger.debug(`Adding multi-reader Gaia links to profile for ${id.name}`);
      profile.apps = {};
    }

    const gaiaPrefix = `${appGaiaConfig.url_prefix}${appGaiaConfig.address}/`;

    if (!profile.apps.hasOwnProperty(appOrigin) || !profile.apps[appOrigin]) {
      needProfileUpdate = true;
      logger.debug(`Setting Gaia read URL ${gaiaPrefix} for ${appOrigin} ` +
        `in profile for ${id.name}`);

      profile.apps[appOrigin] = gaiaPrefix;
    }
    else if (!profile.apps[appOrigin].startsWith(gaiaPrefix)) {
      needProfileUpdate = true;
      logger.debug(`Overriding Gaia read URL for ${appOrigin} from ${profile.apps[appOrigin]} ` +
        `to ${gaiaPrefix} in profile for ${id.name}`);

      profile.apps[appOrigin] = gaiaPrefix;
    }

    return { profile, changed: needProfileUpdate };
  })
}


/*
 * Handle GET /signin?encAuthResponse=...
 * Takes an encrypted authResponse from the page generated on GET /auth?authRequest=....,
 * verifies it, updates the name's profile's app's entry with the latest Gaia
 * hub information (if necessary), and redirects the user back to the application.
 *
 * If adminKey is given, then the new app private key will be automatically added
 * as an authorized writer to the Gaia hub.
 *
 * Redirects the user on success.
 * Sends the user an error page on failure.
 * Returns a Promise that resolves to nothing.
 */
export function handleSignIn(network: Object, 
                             mnemonic: string,
                             appGaiaHub: string, 
                             profileGaiaHub: string,
                             req: express.request, 
                             res: express.response
): Promise<*> {
  
  const encAuthResponse = req.query.encAuthResponse;
  if (!encAuthResponse) {
    return Promise.resolve().then(() => {
      sendJSON(res, { error: 'No encAuthResponse given' }, 400);
    });
  }
  const nameLookupUrl = `${network.blockstackAPIUrl}/v1/names/`;

  let errorMsg;
  let errorStatusCode = 400;
  let authResponsePayload;
    
  let id;
  let profileUrl;
  let appOrigin;
  let redirectUri;
  let scopes;
  let authResponse;

  return Promise.resolve().then(() => {
    // verify and decrypt 
    const valid = new jsontokens.TokenVerifier('ES256K', authTransitPubkey)
      .verify(encAuthResponse)

    if (!valid) {
      throw new Error('Invalid encrypted auth response: not signed by this authenticator')
    }

    const encAuthResponseToken = jsontokens.decodeToken(encAuthResponse)
    const encAuthResponsePayload = encAuthResponseToken.payload;
    
    authResponse = blockstack.decryptContent(
      encAuthResponsePayload.json, { privateKey: authTransitKey });

    return blockstack.verifyAuthResponse(authResponse, nameLookupUrl);
  })
  .then((valid) => {
    if (!valid) {
      errorMsg = `Unable to verify authResponse token ${authResponse}`;
      throw new Error(errorMsg);
    }

    const authResponseToken = jsontokens.decodeToken(authResponse);
    authResponsePayload = authResponseToken.payload;

    id = authResponsePayload.metadata.id;
    profileUrl = authResponsePayload.metadata.profileUrl;
    appOrigin = authResponsePayload.metadata.appOrigin;
    redirectUri = authResponsePayload.metadata.redirect_uri;
    scopes = authResponsePayload.metadata.scopes;

    const appPrivateKey = getAppPrivateKey(network, mnemonic, id, appOrigin);

    // remove sensitive (CLI-specific) information
    authResponsePayload.metadata = {
      profileUrl: profileUrl
    };

    authResponse = new jsontokens.TokenSigner('ES256K', id.privateKey).sign(authResponsePayload);
    
    logger.debug(`App ${appOrigin} requests scopes ${JSON.stringify(scopes)}`);

    // connect to the app gaia hub
    return gaiaConnect(network, appGaiaHub, appPrivateKey);
  })
  .then((appHubConfig) => {
    return updateProfileApps(network, id, appOrigin, appHubConfig);
  })
  .then((newProfileData) => {
    const profile = newProfileData.profile;
    const needProfileUpdate = newProfileData.changed && scopes.includes('store_write');

    // sign and replicate new profile if we need to.
    // otherwise do nothing 
    if (needProfileUpdate) {
      logger.debug(`Upload new profile to ${profileGaiaHub}`);
      const profileJWT = makeProfileJWT(profile, id.privateKey);
      return gaiaUploadProfileAll(
        network, [profileGaiaHub], profileJWT, id.privateKey, id.name);
    }
    else {
      logger.debug(`Gaia read URL for ${appOrigin} is ${profile.apps[appOrigin]}`);
      return { dataUrls: [], error: null };
    }
  })
  .then((gaiaUrls) => {
    if (gaiaUrls.hasOwnProperty('error') && gaiaUrls.error) {
      errorMsg = `Failed to upload new profile: ${gaiaUrls.error}`;
      errorStatusCode = 502;
      throw new Error(errorMsg);
    }

    // success!
    // redirect to application
    const appUri = blockstack.updateQueryStringParameter(redirectUri, 'authResponse', authResponse); 
    res.writeHead(302, {'Location': appUri});
    res.end();
    return;
  })
  .catch((e) => {
    logger.error(e);
    logger.error(errorMsg);
    sendJSON(res, { error: `Unable to process signin request: ${errorMsg}` }, errorStatusCode);
    return;
  });
}
