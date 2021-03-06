'use strict'

const {
  Readable,
  Duplex,
  PassThrough
} = require('stream')
const {
  InvalidArgumentError,
  InvalidReturnValueError,
  NotSupportedError,
  RequestAbortedError
} = require('./errors')
const Request = require('./request')
const util = require('./util')
const assert = require('assert')
const { kResume, kEnqueue } = require('./symbols')

// TODO: Refactor

class PipelineRequest extends Request {
  constructor (client, opts, callback) {
    super(opts, client)

    this.callback = callback
    this.aborted = false
  }

  _onHeaders (statusCode, headers, resume) {
    const { callback } = this

    assert(callback)
    this.callback = null
    this.res = callback.call(this, null, {
      statusCode,
      headers,
      opaque: this.opaque,
      resume
    })
  }

  _onBody (chunk, offset, length) {
    return this.res(null, chunk.slice(offset, offset + length))
  }

  _onComplete (trailers) {
    // TODO: Trailers?

    const res = this.res
    this.res = null
    res(null, null)
  }

  _onError (err) {
    const { callback, res } = this

    if (res) {
      this.res = null
      res(err, null)
    }

    if (callback) {
      this.callback = null
      callback.call(this, err, null)
    }
  }
}

module.exports = function (client, opts, handler) {
  try {
    if (!opts || typeof opts !== 'object') {
      throw new InvalidArgumentError('invalid opts')
    }

    if (typeof handler !== 'function') {
      throw new InvalidArgumentError('invalid handler')
    }

    if (opts.method === 'CONNECT') {
      throw new NotSupportedError('CONNECT method is not supported')
    }

    const req = new Readable({
      autoDestroy: true,
      read () {
        if (this[kResume]) {
          const resume = this[kResume]
          this[kResume] = null
          resume()
        }
      },
      destroy (err, callback) {
        this._read()

        if (err) {
          util.destroy(ret, err)
        } else if (!this._readableState.endEmitted) {
          // This can happen if the server doesn't care
          // about the entire request body.
          ret.end()
        }

        request.runInAsyncScope(callback, null, err, null)
      }
    })

    let res
    let body

    const ret = new Duplex({
      readableObjectMode: opts.objectMode,
      autoDestroy: true,
      read () {
        if (body && body.resume) {
          body.resume()
        }
      },
      write (chunk, encoding, callback) {
        if (req.destroyed || req.push(chunk, encoding)) {
          callback()
        } else {
          req[kResume] = callback
        }
      },
      destroy (err, callback) {
        if (!err && !this._readableState.endEmitted) {
          err = new RequestAbortedError()
        }
        util.destroy(body, err)
        util.destroy(req, err)
        util.destroy(res, err)

        if (err) {
          request.onError(err)
        }

        request.runInAsyncScope(
          callback,
          null,
          err,
          null
        )
      }
    }).on('prefinish', () => {
      // Node < 15 does not call _final in same tick.
      req.push(null)
      client[kResume]()
    })

    // TODO: Avoid copy.
    opts = { ...opts, body: req }

    const request = new PipelineRequest(client, opts, function (err, data) {
      if (err) {
        util.destroy(ret, err)
        return
      }

      const {
        statusCode,
        headers,
        opaque,
        resume
      } = data

      const request = this
      res = new Readable({
        autoDestroy: true,
        read: resume,
        destroy (err, callback) {
          resume()

          if (!err && !this._readableState.endEmitted) {
            err = new RequestAbortedError()
          }

          if (err) {
            util.destroy(ret, err)
          }

          request.runInAsyncScope(
            callback,
            null,
            err,
            null
          )
        }
      })

      try {
        body = handler({
          statusCode,
          headers,
          opaque,
          body: res
        })
      } catch (err) {
        res.on('error', util.nop)
        util.destroy(ret, err)
        return
      }

      // TODO: Should we allow !body?
      if (!body || typeof body.on !== 'function') {
        util.destroy(ret, new InvalidReturnValueError('expected Readable'))
        return
      }

      // TODO: If body === res then avoid intermediate
      // and write directly to ret.push? Or should this
      // happen when body is null?

      let ended = false
      body
        .on('data', function (chunk) {
          if (!ret.push(chunk) && this.pause) {
            this.pause()
          }
        })
        .on('error', function (err) {
          util.destroy(ret, err)
        })
        .on('end', function () {
          ended = true
          ret.push(null)
        })
        .on('close', function () {
          if (!ended) {
            util.destroy(ret, new RequestAbortedError())
          }
        })

      if (typeof body.destroy === 'function') {
        body.destroy = this.runInAsyncScope.bind(this, body.destroy, body)
      }

      return function (err, chunk) {
        if (res.destroyed) {
          return null
        } else if (err) {
          res.destroy(err)
        } else {
          const ret = res.push(chunk)
          return res.destroyed ? null : ret
        }
      }
    })

    client[kEnqueue](request)

    return ret
  } catch (err) {
    return new PassThrough().destroy(err)
  }
}
