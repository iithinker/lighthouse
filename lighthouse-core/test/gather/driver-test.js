/**
 * @license
 * Copyright 2016 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

let sendCommandParams = [];

const Driver = require('../../gather/driver.js');
const Connection = require('../../gather/connections/connection.js');
const Element = require('../../lib/element.js');
const NetworkRecorder = require('../../lib/network-recorder');
const assert = require('assert');

const connection = new Connection();
const driverStub = new Driver(connection);

function createOnceStub(events) {
  return (eventName, cb) => {
    if (events[eventName]) {
      return cb(events[eventName]);
    }

    throw Error(`Stub not implemented: ${eventName}`);
  };
}

function createSWRegistration(id, url, isDeleted) {
  return {
    isDeleted: !!isDeleted,
    registrationId: id,
    scopeURL: url,
  };
}

function createActiveWorker(id, url, controlledClients, status = 'activated') {
  return {
    registrationId: id,
    scriptURL: url,
    controlledClients,
    status,
  };
}

connection.sendCommand = function(command, params) {
  sendCommandParams.push({command, params});
  switch (command) {
    case 'DOM.getDocument':
      return Promise.resolve({root: {nodeId: 249}});
    case 'DOM.querySelector':
      return Promise.resolve({
        nodeId: params.selector === 'invalid' ? 0 : 231
      });
    case 'DOM.querySelectorAll':
      return Promise.resolve({
        nodeIds: params.selector === 'invalid' ? [] : [231]
      });
    case 'Runtime.getProperties':
      return Promise.resolve({
        result: params.objectId === 'invalid' ? [] : [{
          name: 'test',
          value: {
            value: '123'
          }
        }, {
          name: 'novalue'
        }]
      });
    case 'Page.enable':
    case 'Tracing.start':
    case 'ServiceWorker.enable':
    case 'ServiceWorker.disable':
      return Promise.resolve();
    default:
      throw Error(`Stub not implemented: ${command}`);
  }
};

// mock redirects to test out enableUrlUpdateIfRedirected
const req1 = {
  url: 'http://aliexpress.com/'
};
const req2 = {
  redirectSource: req1,
  url: 'http://www.aliexpress.com/'
};
const req3 = {
  redirectSource: req2,
  url: 'http://m.aliexpress.com/?tracelog=wwwhome2mobilesitehome'
};
const mockRedirects = [req1, req2, req3];

/* eslint-env mocha */

describe('Browser Driver', () => {
  beforeEach(() => {
    sendCommandParams = [];
  });

  it('returns null when DOM.querySelector finds no node', () => {
    return driverStub.querySelector('invalid').then(value => {
      assert.equal(value, null);
    });
  });

  it('returns element when DOM.querySelector finds node', () => {
    return driverStub.querySelector('meta head').then(value => {
      assert.equal(value instanceof Element, true);
    });
  });

  it('returns [] when DOM.querySelectorAll finds no node', () => {
    return driverStub.querySelectorAll('invalid').then(value => {
      assert.deepEqual(value, []);
    });
  });

  it('returns element when DOM.querySelectorAll finds node', () => {
    return driverStub.querySelectorAll('a').then(value => {
      assert.equal(value.length, 1);
      assert.equal(value[0] instanceof Element, true);
    });
  });

  it('returns value when getObjectProperty finds property name', () => {
    return driverStub.getObjectProperty('test', 'test').then(value => {
      assert.deepEqual(value, 123);
    });
  });

  it('returns null when getObjectProperty finds no property name', () => {
    return driverStub.getObjectProperty('invalid', 'invalid').then(value => {
      assert.deepEqual(value, null);
    });
  });

  it('returns null when getObjectProperty finds property name with no value', () => {
    return driverStub.getObjectProperty('test', 'novalue').then(value => {
      assert.deepEqual(value, null);
    });
  });

  it('will update the options.url through redirects', () => {
    const networkRecorder = driverStub._networkStatus = new NetworkRecorder([]);
    const opts = {url: req1.url};
    driverStub.enableUrlUpdateIfRedirected(opts);

    // Fake some reqFinished events
    const networkManager = networkRecorder.networkManager;
    mockRedirects.forEach(request => {
      networkManager.dispatchEventToListeners(networkRecorder.EventTypes.RequestFinished, request);
    });

    // The above event is handled synchronously by enableUrlUpdateIfRedirected and will be all set
    assert.notEqual(opts.url, req1.url, 'opts.url changed after the redirects');
    assert.equal(opts.url, req3.url, 'opts.url matches the last redirect');
  });

  it('will request default traceCategories', () => {
    return driverStub.beginTrace().then(() => {
      const traceCmd = sendCommandParams.find(obj => obj.command === 'Tracing.start');
      const categories = traceCmd.params.categories;
      assert.ok(categories.includes('devtools.timeline'), 'contains devtools.timeline');
    });
  });

  it('will use requested additionalTraceCategories', () => {
    return driverStub.beginTrace({additionalTraceCategories: 'v8,v8.execute,toplevel'}).then(() => {
      const traceCmd = sendCommandParams.find(obj => obj.command === 'Tracing.start');
      const categories = traceCmd.params.categories;
      assert.ok(categories.includes('blink'), 'contains default categories');
      assert.ok(categories.includes('v8.execute'), 'contains added categories');
      assert.ok(categories.indexOf('toplevel') === categories.lastIndexOf('toplevel'),
          'de-dupes categories');
    });
  });
});

describe('Multiple tab check', () => {
  beforeEach(() => {
    sendCommandParams = [];
  });

  it('will pass if there are no current service workers', () => {
    const pageUrl = 'https://example.com/';
    driverStub.once = createOnceStub({
      'ServiceWorker.workerRegistrationUpdated': {
        registrations: []
      },
    });

    driverStub.on = createOnceStub({
      'ServiceWorker.workerVersionUpdated': {
        versions: []
      },
    });

    return driverStub.assertNoSameOriginServiceWorkerClients(pageUrl);
  });

  it('will pass if there is an active service worker for a different origin', () => {
    const pageUrl = 'https://example.com/';
    const secondUrl = 'https://example.edu';
    const swUrl = `${secondUrl}sw.js`;

    const registrations = [
      createSWRegistration(1, secondUrl),
    ];
    const versions = [
      createActiveWorker(1, swUrl, ['uniqueId'])
    ];

    driverStub.once = createOnceStub({
      'ServiceWorker.workerRegistrationUpdated': {
        registrations
      },
    });

    driverStub.on = createOnceStub({
      'ServiceWorker.workerVersionUpdated': {
        versions
      },
    });

    return driverStub.assertNoSameOriginServiceWorkerClients(pageUrl);
  });

  it('will fail if a service worker with a matching origin has a controlled client', () => {
    const pageUrl = 'https://example.com/';
    const swUrl = `${pageUrl}sw.js`;
    const registrations = [
      createSWRegistration(1, pageUrl),
    ];
    const versions = [
      createActiveWorker(1, swUrl, ['uniqueId'])
    ];

    driverStub.once = createOnceStub({
      'ServiceWorker.workerRegistrationUpdated': {
        registrations
      }
    });

    driverStub.on = createOnceStub({
      'ServiceWorker.workerVersionUpdated': {
        versions
      },
    });

    return driverStub.assertNoSameOriginServiceWorkerClients(pageUrl)
      .then(_ => assert.ok(false),
          err => {
            assert.ok(err.message.toLowerCase().includes('multiple tabs'));
          });
  });

  it('will succeed if a service worker with a matching origin has no controlled clients', () => {
    const pageUrl = 'https://example.com/';
    const swUrl = `${pageUrl}sw.js`;
    const registrations = [createSWRegistration(1, pageUrl)];
    const versions = [createActiveWorker(1, swUrl, [])];

    driverStub.once = createOnceStub({
      'ServiceWorker.workerRegistrationUpdated': {
        registrations
      },
    });

    driverStub.on = createOnceStub({
      'ServiceWorker.workerVersionUpdated': {
        versions
      },
    });

    return driverStub.assertNoSameOriginServiceWorkerClients(pageUrl);
  });

  it('will wait for serviceworker to be activated', () => {
    const pageUrl = 'https://example.com/';
    const swUrl = `${pageUrl}sw.js`;
    const registrations = [createSWRegistration(1, pageUrl)];
    const versions = [createActiveWorker(1, swUrl, [], 'installing')];

    driverStub.once = createOnceStub({
      'ServiceWorker.workerRegistrationUpdated': {
        registrations
      },
    });

    driverStub.on = (eventName, cb) => {
      if (eventName === 'ServiceWorker.workerVersionUpdated') {
        cb({versions});

        setTimeout(() => {
          cb({
            versions: [
              createActiveWorker(1, swUrl, [], 'activated'),
            ]
          });
        }, 1000);

        return;
      }

      throw Error(`Stub not implemented: ${eventName}`);
    };

    return driverStub.assertNoSameOriginServiceWorkerClients(pageUrl);
  });
});
