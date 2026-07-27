/**
 * Node.js built-in module compatibility shims for the QuickJS sandbox.
 *
 * Plugins built with `target: 'bun'` keep `import { createHash, randomBytes,
 * ... } from "crypto"` and `import { promisify } from "util"` as external
 * (Bun natively provides them).  Inside the QuickJS sandbox there is no Node
 * runtime, so we bridge the most commonly used functions to the host via the
 * synchronous `__hostCallSync` bridge.
 *
 * The shim is injected BEFORE plugin code runs and exposes the symbols on
 * `__module_crypto` / `__module_net` / `__module_util` globals.  The
 * `esmShim` then rewrites `import { ... } from "crypto"` to read from
 * `__module_crypto` instead (and likewise for net / util).
 *
 * Supported crypto functions (all synchronous, matching Node's API):
 *   • createHash(algorithm) → { update(data), digest(encoding?) }
 *   • randomBytes(size) → Uint8Array
 *   • createHmac(algorithm, key) → { update(data), digest(encoding?) }
 *   • timingSafeEqual(a, b) → boolean
 *   • webcrypto → alias to `globalThis.crypto` (the WebCrypto shim)
 *   • generateKeyPairSync('rsa', opts) → { publicKey, privateKey } (PEM)
 *   • createSign(algorithm) → { update(data), sign(privateKeyPem) }
 *   • sign(algorithm, data, key) → Uint8Array (one-shot RSA signing)
 *   • createPublicKey(pem) → { export({ format: 'jwk' }) } (JWK conversion)
 *   • createPrivateKey(pem) → { export({ format: 'pem' }) } (passthrough)
 *
 * Supported util functions:
 *   • promisify(fn) → returns a Promise-returning wrapper around a
 *     callback-style function. Only the common single-callback shape is
 *     bridged; multi-arg resolvers are not.
 *   • inspect(value) → best-effort stringification (JSON with fallback).
 *   • isDeepStrictEqual(a, b) → structural equality.
 *
 * Unsupported (throw a clear error):
 *   • crypto: createVerify / verify (RSA verification — not needed by plugins)
 *   • net: createConnection / connect (use fetch() instead)
 *   • util: format, debuglog, types — not commonly needed in plugin code
 */

export const NODE_CRYPTO_SHIM = `// ------- Node crypto compatibility shim ------------------------------------
// Provides createHash, randomBytes, createHmac, timingSafeEqual, and
// webcrypto for plugin bundles that import from "crypto".  Bridges to the
// host synchronously via __hostCallSync('crypto.*').
var __module_crypto = (function () {
  function __notSupported(name) {
    return function () {
      throw new Error('Node crypto.' + name + ' is not supported in the QuickJS sandbox. Use crypto.subtle instead.');
    };
  }

  function Hash(algorithm) {
    this._algorithm = (typeof algorithm === 'string' ? algorithm : (algorithm && algorithm.name)) || 'sha256';
    this._chunks = [];
  }
  Hash.prototype.update = function (data) {
    if (typeof data === 'string') {
      this._chunks.push(__utf8Encode(data));
    } else if (data instanceof Uint8Array) {
      this._chunks.push(data);
    } else if (data instanceof ArrayBuffer) {
      this._chunks.push(new Uint8Array(data));
    } else if (data && data.buffer instanceof ArrayBuffer) {
      this._chunks.push(new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength));
    } else {
      throw new TypeError('Hash.update data must be string or BufferSource');
    }
    return this;
  };
  Hash.prototype.digest = function (encoding) {
    var total = 0;
    for (var i = 0; i < this._chunks.length; i++) total += this._chunks[i].length;
    var combined = new Uint8Array(total);
    var offset = 0;
    for (var j = 0; j < this._chunks.length; j++) {
      combined.set(this._chunks[j], offset);
      offset += this._chunks[j].length;
    }
    var algo = this._algorithm.toLowerCase().replace(/-/g, '');
    var wcName;
    if (algo === 'sha256') wcName = 'SHA-256';
    else if (algo === 'sha1') wcName = 'SHA-1';
    else if (algo === 'sha512') wcName = 'SHA-512';
    else if (algo === 'md5') wcName = 'MD5';
    else wcName = this._algorithm;
    var base64In = __bytesToBase64(combined);
    var resultBase64 = __hostCallSync('crypto.digest', [{ algorithm: wcName, data: base64In }]);
    var bytes = __base64ToBytes(String(resultBase64));
    if (encoding === 'hex') {
      var hex = '';
      for (var k = 0; k < bytes.length; k++) {
        hex += (bytes[k] < 16 ? '0' : '') + bytes[k].toString(16);
      }
      return hex;
    }
    if (encoding === 'base64') {
      return __bytesToBase64(bytes);
    }
    return bytes;
  };

  function Hmac(algorithm, key) {
    this._hashName = (typeof algorithm === 'string' ? algorithm : (algorithm && algorithm.name)) || 'sha256';
    this._keyB64 = __cryptoInputToBase64(key);
    this._chunks = [];
  }
  Hmac.prototype.update = function (data) {
    if (typeof data === 'string') {
      this._chunks.push(__utf8Encode(data));
    } else if (data instanceof Uint8Array) {
      this._chunks.push(data);
    } else if (data instanceof ArrayBuffer) {
      this._chunks.push(new Uint8Array(data));
    } else if (data && data.buffer instanceof ArrayBuffer) {
      this._chunks.push(new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength));
    } else {
      throw new TypeError('Hmac.update data must be string or BufferSource');
    }
    return this;
  };
  Hmac.prototype.digest = function (encoding) {
    var total = 0;
    for (var i = 0; i < this._chunks.length; i++) total += this._chunks[i].length;
    var combined = new Uint8Array(total);
    var offset = 0;
    for (var j = 0; j < this._chunks.length; j++) {
      combined.set(this._chunks[j], offset);
      offset += this._chunks[j].length;
    }
    var dataB64 = __bytesToBase64(combined);
    var algo = this._hashName.toLowerCase().replace(/-/g, '');
    var hashName;
    if (algo === 'sha256') hashName = 'SHA-256';
    else if (algo === 'sha1') hashName = 'SHA-1';
    else if (algo === 'sha512') hashName = 'SHA-512';
    else hashName = this._hashName;
    var resultBase64 = __hostCallSync('crypto.signHmac', [{ hash: hashName, key: this._keyB64, data: dataB64 }]);
    var bytes = __base64ToBytes(String(resultBase64));
    if (encoding === 'hex') {
      var hex = '';
      for (var k = 0; k < bytes.length; k++) {
        hex += (bytes[k] < 16 ? '0' : '') + bytes[k].toString(16);
      }
      return hex;
    }
    if (encoding === 'base64') {
      return __bytesToBase64(bytes);
    }
    return bytes;
  };

  function createHash(algorithm) {
    return new Hash(algorithm);
  }

  function createHmac(algorithm, key) {
    return new Hmac(algorithm, key);
  }

  function randomBytes(size) {
    var result = __hostCallSync('crypto.randomBytes', [{ size: size }]);
    return __base64ToBytes(String(result));
  }

  function timingSafeEqual(a, b) {
    if (!(a instanceof Uint8Array)) {
      if (a && a.buffer instanceof ArrayBuffer) {
        a = new Uint8Array(a.buffer, a.byteOffset || 0, a.byteLength);
      } else {
        a = new Uint8Array(a);
      }
    }
    if (!(b instanceof Uint8Array)) {
      if (b && b.buffer instanceof ArrayBuffer) {
        b = new Uint8Array(b.buffer, b.byteOffset || 0, b.byteLength);
      } else {
        b = new Uint8Array(b);
      }
    }
    if (a.length !== b.length) return false;
    var diff = 0;
    for (var i = 0; i < a.length; i++) {
      diff |= a[i] ^ b[i];
    }
    return diff === 0;
  }

  return {
    createHash: createHash,
    createHmac: createHmac,
    randomBytes: randomBytes,
    timingSafeEqual: timingSafeEqual,
    webcrypto: globalThis.crypto,
    // RSA operations — bridged to host via __hostCallSync('crypto.*').
    // These are the asymmetric operations OIDC / social-login plugins need.
    generateKeyPairSync: function (type, options) {
      if (type !== 'rsa') {
        throw new Error('Node crypto.generateKeyPairSync: only "rsa" is supported in the QuickJS sandbox.');
      }
      var opts = options || {};
      var resultJson = __hostCallSync('crypto.generateKeyPair', [{
        type: type,
        modulusLength: opts.modulusLength || 2048,
        publicKeyEncoding: opts.publicKeyEncoding || { type: 'spki', format: 'pem' },
        privateKeyEncoding: opts.privateKeyEncoding || { type: 'pkcs8', format: 'pem' },
      }]);
      var parsed = JSON.parse(String(resultJson));
      return { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
    },
    createSign: function (algorithm) {
      this._algorithm = algorithm || 'RSA-SHA256';
      this._chunks = [];
      this.update = function (data) {
        if (typeof data === 'string') {
          this._chunks.push(__utf8Encode(data));
        } else if (data instanceof Uint8Array) {
          this._chunks.push(data);
        } else if (data instanceof ArrayBuffer) {
          this._chunks.push(new Uint8Array(data));
        } else if (data && data.buffer instanceof ArrayBuffer) {
          this._chunks.push(new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength));
        }
        return this;
      };
      this.sign = function (privateKeyPem) {
        var total = 0;
        for (var i = 0; i < this._chunks.length; i++) total += this._chunks[i].length;
        var combined = new Uint8Array(total);
        var offset = 0;
        for (var j = 0; j < this._chunks.length; j++) {
          combined.set(this._chunks[j], offset);
          offset += this._chunks[j].length;
        }
        var dataB64 = __bytesToBase64(combined);
        var sigB64 = __hostCallSync('crypto.signRsa', [{
          algorithm: this._algorithm,
          privateKeyPem: typeof privateKeyPem === 'string' ? privateKeyPem : String(privateKeyPem),
          data: dataB64,
        }]);
        return __base64ToBytes(String(sigB64));
      };
      return this;
    },
    sign: function (algorithm, data, key) {
      // Node's crypto.sign(algorithm, data, key) — one-shot signing.
      var dataB64;
      if (typeof data === 'string') dataB64 = __bytesToBase64(__utf8Encode(data));
      else if (data instanceof Uint8Array) dataB64 = __bytesToBase64(data);
      else if (data instanceof ArrayBuffer) dataB64 = __bytesToBase64(new Uint8Array(data));
      else if (data && data.buffer instanceof ArrayBuffer) dataB64 = __bytesToBase64(new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength));
      else dataB64 = __bytesToBase64(__utf8Encode(String(data)));
      var keyPem = typeof key === 'object' && key ? (key.export ? key.export({ format: 'pem', type: 'pkcs8' }) : String(key)) : String(key);
      var sigB64 = __hostCallSync('crypto.signRsa', [{
        algorithm: algorithm,
        privateKeyPem: keyPem,
        data: dataB64,
      }]);
      return __base64ToBytes(String(sigB64));
    },
    createPublicKey: function (pem) {
      var pemStr = typeof pem === 'string' ? pem : String(pem);
      return {
        _pem: pemStr,
        export: function (opts) {
          if (opts && opts.format === 'jwk') {
            var jwkJson = __hostCallSync('crypto.publicKeyToJwk', [{ publicKeyPem: pemStr }]);
            return JSON.parse(String(jwkJson));
          }
          throw new Error('crypto.createPublicKey().export: only format: "jwk" is supported in the sandbox.');
        },
      };
    },
    createPrivateKey: function (pem) {
      var pemStr = typeof pem === 'string' ? pem : String(pem);
      return {
        _pem: pemStr,
        export: function (opts) {
          if (opts && opts.format === 'pem') return pemStr;
          throw new Error('crypto.createPrivateKey().export: only format: "pem" is supported in the sandbox.');
        },
      };
    },
    createVerify: __notSupported('createVerify'),
    verify: __notSupported('verify'),
  };
})();
// net module stub — throws when used (plugins should use fetch() instead).
var __module_net = {
  createConnection: function () {
    throw new Error('Node net.createConnection is not supported in the QuickJS sandbox. Use fetch() instead.');
  },
  connect: function () {
    throw new Error('Node net.connect is not supported in the QuickJS sandbox. Use fetch() instead.');
  },
};
// ------- Node util compatibility shim -------------------------------------
// Provides promisify, inspect, isDeepStrictEqual — the subset plugins
// commonly pull from "util". More exotic helpers (format, debuglog, types)
// are intentionally absent; surface a clear error if requested.
var __module_util = (function () {
  function promisify(original) {
    if (typeof original !== 'function') {
      throw new TypeError('util.promisify requires a function');
    }
    return function () {
      var args = [];
      for (var i = 0; i < arguments.length; i++) args.push(arguments[i]);
      return new Promise(function (resolve, reject) {
        args.push(function (err, value) {
          if (err) reject(err);
          else resolve(value);
        });
        try {
          original.apply(null, args);
        } catch (e) {
          reject(e);
        }
      });
    };
  }

  function inspect(value, depth) {
    try {
      return JSON.stringify(value, null, (typeof depth === 'number' ? Math.min(depth, 4) : 2));
    } catch (e) {
      return String(value);
    }
  }

  function isDeepStrictEqual(a, b) {
    if (a === b) return true;
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
      return false;
    }
    if (a instanceof Uint8Array && b instanceof Uint8Array) {
      if (a.length !== b.length) return false;
      for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
      return true;
    }
    var ka = Object.keys(a);
    var kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (var k = 0; k < ka.length; k++) {
      var key = ka[k];
      if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
      if (!isDeepStrictEqual(a[key], b[key])) return false;
    }
    return true;
  }

  return {
    promisify: promisify,
    inspect: inspect,
    isDeepStrictEqual: isDeepStrictEqual,
  };
})();
`
