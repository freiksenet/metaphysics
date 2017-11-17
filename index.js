// @ts-check

import Bluebird from "bluebird"
import "artsy-newrelic"
import xapp from "artsy-xapp"
import cors from "cors"
import depthLimit from "graphql-depth-limit"
import morgan from "artsy-morgan"
import express from "express"
import forceSSL from "express-force-ssl"
import graphqlHTTP from "express-graphql"
import bodyParser from "body-parser"
import schema from "./schema"
import legacyLoaders from "./lib/loaders/legacy"
import createLoaders from "./lib/loaders"
import config from "./config"
import { info, error } from "./lib/loggers"
import graphqlErrorHandler from "./lib/graphql-error-handler"
import moment from "moment"
import "moment-timezone"
import Tracer from "datadog-tracer"
import { forIn, has, assign } from "lodash"

global.Promise = Bluebird

const { PORT, NODE_ENV, GRAVITY_API_URL, GRAVITY_ID, GRAVITY_SECRET, QUERY_DEPTH_LIMIT } = process.env

const app = express()
const port = PORT || 3000
const queryLimit = parseInt(QUERY_DEPTH_LIMIT, 10) || 10 // Default to ten.

if (NODE_ENV === "production") {
  app.set("forceSSLOptions", { trustXFPHeader: true }).use(forceSSL)
  app.set("trust proxy", 1)
}

xapp.on("error", err => {
  error(err)
  process.exit()
})

xapp.init(
  {
    url: GRAVITY_API_URL,
    id: GRAVITY_ID,
    secret: GRAVITY_SECRET,
  },
  () => (config.GRAVITY_XAPP_TOKEN = xapp.token)
)

app.get("/favicon.ico", (_req, res) => {
  res
    .status(200)
    .set({ "Content-Type": "image/x-icon" })
    .end()
})

app.all("/graphql", (req, res) => res.redirect("/"))

app.use(bodyParser.json())

function parse_args() {
  return "( ... )"
}

function trace(res, span) {
  span.addTags({
    "http.status_code": res.statusCode,
  })
  span.finish()
}

app.use((req, res, next) => {
  if (req.method === "POST") {
    const tracer = new Tracer({ service: "metaphysics" })
    const span = tracer.startSpan("metaphysics.query")
    const query = req.body.query.replace(/(\()([^\)]*)(\))/g, parse_args)
    span.addTags({
      resource: query,
      type: "web",
      "span.kind": "server",
      "http.method": req.method,
      "http.url": req.url,
    })

    assign(req, { span })

    res.on("finish", () => trace(res, span))
    res.on("close", () => trace(res, span))
  }
  next()
})

function wrapResolve(typeName, fieldName, resolver) {
  return function (root, options, request) {
    const parentSpan = request.span
    const span = parentSpan.tracer().startSpan("metaphysics.resolver." + typeName + "." + fieldName,
      { childOf: parentSpan.context() })
    span.addTags({
      resource: typeName + ": " + fieldName,
      type: "web",
      "span.kind": "server",
    })

    assign(request, { span })
    const result = resolver.apply(this, arguments);
    assign(request, { span: parentSpan })

    if (result instanceof Promise) {
      return result.finally(function () {
        span.finish()
      })
    }

    span.finish()
    return result;
  };
}

// Walk the schema and for all object type fields with resolvers wrap them in our tracing resolver.
forIn(schema._typeMap, function (value, key) {
  const typeName = key
  if (has(value, "_fields")) {
    forIn(value._fields, function (field, fieldName) {
      if (has(field, "resolve") && field.resolve instanceof Function) {
        assign(field, { resolve: wrapResolve(typeName, fieldName, field.resolve) })
      }
    });
  }
});

app.use(
  "/",
  cors(),
  morgan,
  graphqlHTTP(request => {
    info("----------")

    legacyLoaders.clearAll()

    const accessToken = request.headers["x-access-token"]
    const userID = request.headers["x-user-id"]
    const timezone = request.headers["x-timezone"]
    const requestID = request.headers["x-request-id"] || "implement-me"
    const requestIDs = { requestID }

    if (request.span) {
      const context = request.span.context()
      const traceId = context.traceId
      const parentSpanId = context.spanId

      assign(requestIDs, { traceId, parentSpanId })
    }

    // Accepts a tz database timezone string. See http://www.iana.org/time-zones,
    // https://en.wikipedia.org/wiki/List_of_tz_database_time_zones
    let defaultTimezone
    if (moment.tz.zone(timezone)) {
      defaultTimezone = timezone
    }

    return {
      schema,
      graphiql: true,
      rootValue: {
        accessToken,
        userID,
        defaultTimezone,
        ...createLoaders(accessToken, userID, requestIDs),
      },
      formatError: graphqlErrorHandler(request.body),
      validationRules: [depthLimit(queryLimit)],
    }
  })
)

app.listen(port, () => info(`Listening on ${port}`))
