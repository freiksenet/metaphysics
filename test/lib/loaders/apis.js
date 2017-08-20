import { apiLoaderWithAuthenticationFactory, apiLoaderWithoutAuthenticationFactory } from "lib/loaders/apis"
import cache from "lib/cache"

describe("API loaders", () => {
  let api = null
  let apiLoader = null
  let loader = null

  beforeEach(() => {
    api = jest.fn((path, accessToken, options) => Promise.resolve({ body: { path, accessToken, options } }))
  })

  const sharedExamples = () => {
    describe("concerning path", () => {
      it("generates path specific loaders", () => {
        return loader().then(({ path }) => {
          expect(path).toEqual("some/path?")
        })
      })

      it("yields a given ID to the loader", () => {
        loader = apiLoader(id => `some/path/with/id/${id}`)
        return loader(42).then(({ path }) => {
          expect(path).toEqual("some/path/with/id/42?")
        })
      })

      it("appends params to the path", () => {
        return loader(null, { some: "param" }).then(({ path }) => {
          expect(path).toEqual("some/path?some=param")
        })
      })

      it("sets default params and merges with specific params", () => {
        loader = apiLoader("some/path", {}, { defaultParam: "value" })
        return loader(null, { some: "param" }).then(({ path }) => {
          expect(path).toEqual("some/path?defaultParam=value&some=param")
        })
      })
    })

    it("caches the response for the lifetime of the loader", () => {
      return Promise.all([loader(), loader()]).then(responses => {
        expect(responses.map(({ path }) => path)).toEqual(["some/path?", "some/path?"])
        expect(api.mock.calls.length).toEqual(1)
      })
    })
  }

  describe("without authentication", () => {
    beforeEach(() => {
      apiLoader = apiLoaderWithoutAuthenticationFactory(api)
      loader = apiLoader("some/path")
    })

    sharedExamples()

    it("does not try to pass an access token", () => {
      return loader().then(({ accessToken }) => {
        expect(accessToken).toEqual(undefined)
      })
    })

    it("caches the response in memcache", () => {
      return cache
        .get("some/unauthenticated/memcached/path?")
        .then(() => {
          throw new Error("Did not expect to be cached yet!")
        })
        .catch(() => {
          loader = apiLoader("some/unauthenticated/memcached/path")
          return loader().then(() => {
            return cache.get("some/unauthenticated/memcached/path?").then(({ path }) => {
              expect(path).toEqual("some/unauthenticated/memcached/path?")
            })
          })
        })
    })
  })

  describe("with authentication", () => {
    beforeEach(() => {
      apiLoader = apiLoaderWithAuthenticationFactory(api)(() => Promise.resolve("secret-token"))
      loader = apiLoader("some/path")
    })

    sharedExamples()

    it("does pass an access token", () => {
      return loader().then(({ accessToken }) => {
        expect(accessToken).toEqual("secret-token")
      })
    })

    it("does NOT cache the response in memcache", () => {
      loader = apiLoader("some/authenticated/memcached/path")
      return loader().then(() => {
        return cache
          .get("some/authenticated/memcached/path?")
          .then(() => {
            throw new Error("Did not expect response to be cached!")
          })
          .catch(() => {
            // swallow the error, because this is the expected code-path
          })
      })
    })
  })
})
