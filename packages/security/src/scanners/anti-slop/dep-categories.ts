import type { DeclaredEcosystem } from '../../validation/declared.js';

// The duplicate-purpose category table (W18-06, mechanical-checks plan R-20).
//
// VERSIONED because a finding cites it: "dayjs and moment overlap" is a claim
// this table makes, and when a row changes, findings produced under the old
// row must still be explainable. Bump DEP_CATEGORY_TABLE_VERSION on any change
// to membership.
//
// WHAT EARNS A ROW. Two members of a category must do the SAME job, so that a
// project holding both pays for two APIs, two upgrade paths and two sets of
// semantics with nothing gained. Libraries that are commonly paired ON
// PURPOSE are left out, and the reason is written down in EXCLUDED below — a
// table that flagged knex next to objection (objection runs ON knex) would be
// wrong about the tool, not the code.
//
// A MEMBER is one library under every name it has shipped under (hibernate's
// two groupIds), so a rename in progress is not two libraries.

export const DEP_CATEGORY_TABLE_VERSION = 'dep-categories.v1';

export type DepPurpose = 'dates' | 'http-client' | 'logger' | 'test-runner' | 'validation' | 'orm';

export interface CategoryMember {
  /** Display name. */
  id: string;
  /** Every package name it ships under in this ecosystem. */
  names: readonly string[];
}

export interface DepCategory {
  ecosystem: DeclaredEcosystem;
  purpose: DepPurpose;
  members: readonly CategoryMember[];
  /** Why any two members overlap — quoted in the finding. */
  why: string;
}

export interface ExcludedLibrary {
  ecosystem: DeclaredEcosystem;
  name: string;
  why: string;
}

const m = (id: string, ...names: string[]): CategoryMember => ({
  id,
  names: names.length ? names : [id],
});

export const DEP_CATEGORIES: readonly DepCategory[] = [
  // ---- npm --------------------------------------------------------------
  {
    ecosystem: 'npm',
    purpose: 'dates',
    members: [m('moment'), m('dayjs'), m('date-fns'), m('luxon')],
    why: 'each parses, formats, compares and does arithmetic on dates; two of them means two formatting-token dialects (moment "YYYY" vs date-fns "yyyy") in one codebase',
  },
  {
    ecosystem: 'npm',
    purpose: 'http-client',
    members: [
      m('axios'),
      m('got'),
      m('node-fetch'),
      m('superagent'),
      m('request'),
      m('ky'),
      m('needle'),
    ],
    why: 'each is a general-purpose HTTP client; two of them means two retry, timeout, interceptor and error-shape conventions for the same outbound calls',
  },
  {
    ecosystem: 'npm',
    purpose: 'logger',
    members: [
      m('winston'),
      m('pino'),
      m('bunyan'),
      m('log4js'),
      m('loglevel'),
      m('signale'),
      m('roarr'),
    ],
    why: 'each is an application logger with its own levels, transports and record shape; two of them split one service’s logs into two formats',
  },
  {
    ecosystem: 'npm',
    purpose: 'test-runner',
    members: [m('jest'), m('mocha'), m('vitest'), m('ava'), m('jasmine'), m('tap'), m('uvu')],
    why: 'each discovers and runs unit tests with its own globals and config; as RUNTIME dependencies, two of them ship test tooling to production twice',
  },
  {
    ecosystem: 'npm',
    purpose: 'validation',
    members: [
      m('zod'),
      m('joi', 'joi', '@hapi/joi'),
      m('yup'),
      m('superstruct'),
      m('valibot'),
      m('io-ts'),
      m('runtypes'),
      m('class-validator'),
    ],
    why: 'each declares a schema in code and validates values against it; two of them means two schema languages describing the same inputs',
  },
  {
    ecosystem: 'npm',
    purpose: 'orm',
    members: [
      m('prisma', '@prisma/client'),
      m('typeorm'),
      m('sequelize'),
      m('drizzle-orm'),
      m('mikro-orm', '@mikro-orm/core'),
      m('objection'),
      m('bookshelf'),
    ],
    why: 'each maps SQL tables to application objects with its own migrations and connection pool; two of them is two sources of truth for one schema',
  },
  // ---- PyPI -------------------------------------------------------------
  {
    ecosystem: 'pypi',
    purpose: 'dates',
    members: [m('arrow'), m('pendulum'), m('maya'), m('delorean')],
    why: 'each is a replacement datetime type with its own parsing, humanising and timezone model; two of them means values that do not compare without conversion',
  },
  {
    ecosystem: 'pypi',
    purpose: 'http-client',
    members: [m('requests'), m('httpx'), m('treq'), m('pycurl')],
    why: 'each is a general-purpose HTTP client; two of them means two session, timeout and exception hierarchies for the same outbound calls',
  },
  {
    ecosystem: 'pypi',
    purpose: 'logger',
    members: [m('loguru'), m('structlog'), m('logbook'), m('eliot')],
    why: 'each replaces or wraps the stdlib logging pipeline with its own processors and sinks; two of them configure the same process twice',
  },
  {
    ecosystem: 'pypi',
    purpose: 'test-runner',
    members: [m('pytest'), m('nose'), m('nose2'), m('ward')],
    why: 'each collects and runs tests with its own discovery rules; as RUNTIME dependencies, two of them ship test tooling to production twice',
  },
  {
    ecosystem: 'pypi',
    purpose: 'validation',
    members: [
      m('pydantic'),
      m('marshmallow'),
      m('cerberus'),
      m('voluptuous'),
      m('schema'),
      m('schematics'),
    ],
    why: 'each declares a schema in code and validates and coerces data against it; two of them means two models of the same payloads',
  },
  {
    ecosystem: 'pypi',
    purpose: 'orm',
    members: [m('sqlalchemy'), m('peewee'), m('pony'), m('tortoise-orm'), m('sqlobject')],
    why: 'each maps tables to classes with its own session and migration story; two of them is two sources of truth for one schema',
  },
  // ---- Go ---------------------------------------------------------------
  {
    ecosystem: 'go',
    purpose: 'http-client',
    members: [
      m('resty', 'github.com/go-resty/resty'),
      m('req', 'github.com/imroc/req'),
      m('gorequest', 'github.com/parnurzeal/gorequest'),
      m('sling', 'github.com/dghubble/sling'),
    ],
    why: 'each is a request-builder over net/http with its own retry, middleware and error conventions; two of them wrap the same transport twice',
  },
  {
    ecosystem: 'go',
    purpose: 'logger',
    members: [
      m('logrus', 'github.com/sirupsen/logrus'),
      m('zap', 'go.uber.org/zap'),
      m('zerolog', 'github.com/rs/zerolog'),
      m('apex/log', 'github.com/apex/log'),
      m('log15', 'github.com/inconshreveable/log15'),
    ],
    why: 'each is a structured logger with its own field API and encoder; two of them emit one service’s logs in two shapes',
  },
  {
    ecosystem: 'go',
    purpose: 'test-runner',
    members: [
      m('ginkgo', 'github.com/onsi/ginkgo'),
      m('gocheck', 'gopkg.in/check.v1'),
      m('goconvey', 'github.com/smartystreets/goconvey'),
    ],
    why: 'each replaces `go test` discovery with its own suite structure. go.mod has no dev scope, so this row is never evaluated (see devScopeKnown)',
  },
  {
    ecosystem: 'go',
    purpose: 'validation',
    members: [
      m('validator', 'github.com/go-playground/validator'),
      m('ozzo-validation', 'github.com/go-ozzo/ozzo-validation'),
      m('govalidator', 'github.com/asaskevich/govalidator'),
    ],
    why: 'each validates structs against declared rules (tags or code); two of them means two rule languages for the same structs',
  },
  {
    ecosystem: 'go',
    purpose: 'orm',
    members: [
      m('gorm', 'gorm.io/gorm', 'github.com/jinzhu/gorm'),
      m('ent', 'entgo.io/ent'),
      m('bun', 'github.com/uptrace/bun'),
      m('go-pg', 'github.com/go-pg/pg'),
      m('sqlboiler', 'github.com/volatiletech/sqlboiler'),
      m('xorm', 'xorm.io/xorm'),
    ],
    why: 'each maps tables to structs with its own query builder and migrations; two of them is two sources of truth for one schema',
  },
  // ---- Maven ------------------------------------------------------------
  {
    ecosystem: 'maven',
    purpose: 'dates',
    members: [m('joda-time', 'joda-time:joda-time'), m('threetenbp', 'org.threeten:threetenbp')],
    why: 'both are pre-java.time date-time libraries covering the same API surface; holding both keeps two incompatible date types alive',
  },
  {
    ecosystem: 'maven',
    purpose: 'http-client',
    members: [
      m(
        'apache-httpclient',
        'org.apache.httpcomponents:httpclient',
        'org.apache.httpcomponents.client5:httpclient5',
      ),
      m('okhttp', 'com.squareup.okhttp3:okhttp', 'com.squareup.okhttp:okhttp'),
      m('async-http-client', 'org.asynchttpclient:async-http-client'),
      m('unirest', 'com.konghq:unirest-java', 'com.mashape.unirest:unirest-java'),
    ],
    why: 'each is a general-purpose HTTP client with its own connection pool; two of them means two pools, two TLS configurations and two timeout models',
  },
  {
    ecosystem: 'maven',
    purpose: 'logger',
    members: [
      m('logback', 'ch.qos.logback:logback-classic'),
      m('log4j2', 'org.apache.logging.log4j:log4j-core'),
      m('log4j1', 'log4j:log4j', 'ch.qos.reload4j:reload4j'),
      m('slf4j-simple', 'org.slf4j:slf4j-simple'),
      m('tinylog', 'org.tinylog:tinylog-impl'),
    ],
    why: 'each is a logging BACKEND; SLF4J binds exactly one and warns "multiple bindings" when it finds more, so which one wins depends on classpath order. Facades and bridges (slf4j-api, log4j-to-slf4j) are deliberately not members',
  },
  {
    ecosystem: 'maven',
    purpose: 'test-runner',
    members: [
      m(
        'junit',
        'junit:junit',
        'org.junit.jupiter:junit-jupiter',
        'org.junit.jupiter:junit-jupiter-api',
      ),
      m('testng', 'org.testng:testng'),
      m('spock', 'org.spockframework:spock-core'),
    ],
    why: 'each is a test engine; outside test scope, two of them ship test tooling in the artifact twice',
  },
  {
    ecosystem: 'maven',
    purpose: 'orm',
    members: [
      m('hibernate', 'org.hibernate:hibernate-core', 'org.hibernate.orm:hibernate-core'),
      m('mybatis', 'org.mybatis:mybatis'),
      m('eclipselink', 'org.eclipse.persistence:eclipselink'),
      m('ebean', 'io.ebean:ebean'),
    ],
    why: 'each maps tables to objects with its own session and cache; two of them is two sources of truth for one schema and two first-level caches over it',
  },
  // ---- Cargo ------------------------------------------------------------
  {
    ecosystem: 'cargo',
    purpose: 'dates',
    members: [m('chrono'), m('jiff')],
    why: 'both are full date-time libraries with their own zone-aware types; values from one do not convert to the other without a round-trip through a timestamp',
  },
  {
    ecosystem: 'cargo',
    purpose: 'http-client',
    members: [m('reqwest'), m('ureq'), m('surf'), m('isahc'), m('attohttpc')],
    why: 'each is a high-level HTTP client; two of them compile two TLS stacks and two connection models into one binary',
  },
  {
    ecosystem: 'cargo',
    purpose: 'logger',
    members: [m('env_logger'), m('simplelog'), m('fern'), m('flexi_logger'), m('log4rs')],
    why: 'each is a `log` BACKEND, and `log::set_logger` succeeds exactly once per process — the second one to initialise fails or is silently ignored',
  },
  {
    ecosystem: 'cargo',
    purpose: 'validation',
    members: [m('validator'), m('garde')],
    why: 'both derive struct validation from attributes; two of them means two rule syntaxes on the same structs',
  },
  {
    ecosystem: 'cargo',
    purpose: 'orm',
    members: [m('diesel'), m('sea-orm'), m('rbatis')],
    why: 'each maps tables to structs with its own schema and migrations; two of them is two sources of truth for one schema',
  },
];

/**
 * Libraries deliberately NOT in any row, with why. Read by the tests, so a
 * later edit that adds one of these has to delete its reason first.
 */
export const EXCLUDED: readonly ExcludedLibrary[] = [
  { ecosystem: 'npm', name: 'knex', why: 'a query builder that objection and bookshelf run on' },
  {
    ecosystem: 'npm',
    name: 'mongoose',
    why: 'a MongoDB ODM; pairs with a SQL ORM when there are two stores',
  },
  {
    ecosystem: 'npm',
    name: 'ajv',
    why: 'validates JSON Schema documents, often alongside a code-first validator by design',
  },
  {
    ecosystem: 'npm',
    name: 'undici',
    why: 'commonly installed only for its dispatcher/ProxyAgent under native fetch',
  },
  {
    ecosystem: 'npm',
    name: 'cross-fetch',
    why: 'a fetch polyfill for SSR, not a second client API',
  },
  { ecosystem: 'npm', name: 'debug', why: 'a namespaced debug printer, not an application logger' },
  {
    ecosystem: 'npm',
    name: '@playwright/test',
    why: 'end-to-end runner; pairs with a unit runner by design',
  },
  {
    ecosystem: 'npm',
    name: 'cypress',
    why: 'end-to-end runner; pairs with a unit runner by design',
  },
  {
    ecosystem: 'pypi',
    name: 'aiohttp',
    why: 'also a web server framework; a requests client beside an aiohttp server is not duplication',
  },
  {
    ecosystem: 'pypi',
    name: 'urllib3',
    why: 'requests’ transport, routinely pinned directly for security fixes',
  },
  { ecosystem: 'pypi', name: 'httplib2', why: 'pinned directly for google-api-python-client' },
  {
    ecosystem: 'pypi',
    name: 'python-dateutil',
    why: 'extends stdlib datetime and is used by arrow and pandas themselves',
  },
  { ecosystem: 'pypi', name: 'sqlmodel', why: 'built on SQLAlchemy and pairs with it by design' },
  { ecosystem: 'pypi', name: 'django', why: 'a framework whose ORM is not separable' },
  {
    ecosystem: 'pypi',
    name: 'jsonschema',
    why: 'validates JSON Schema documents, often alongside a code-first validator by design',
  },
  {
    ecosystem: 'go',
    name: 'k8s.io/klog',
    why: 'required to configure Kubernetes client logging beside an app logger',
  },
  { ecosystem: 'go', name: 'github.com/golang/glog', why: 'pulled in for the same reason as klog' },
  {
    ecosystem: 'go',
    name: 'github.com/go-logr/logr',
    why: 'an interface, implemented by zap/zerolog adapters',
  },
  {
    ecosystem: 'go',
    name: 'github.com/valyala/fasthttp',
    why: 'a server first; its client is incidental',
  },
  {
    ecosystem: 'go',
    name: 'github.com/stretchr/testify',
    why: 'assertions, used inside ginkgo and plain go test alike',
  },
  {
    ecosystem: 'maven',
    name: 'org.jooq:jooq',
    why: 'recommended beside a JPA ORM for reporting queries',
  },
  { ecosystem: 'maven', name: 'com.squareup.retrofit2:retrofit', why: 'a typed layer over okhttp' },
  { ecosystem: 'maven', name: 'org.slf4j:slf4j-api', why: 'a facade, not a backend' },
  {
    ecosystem: 'maven',
    name: 'org.hibernate.validator:hibernate-validator',
    why: 'the implementation of the Bean Validation API, not a rival to it',
  },
  {
    ecosystem: 'cargo',
    name: 'time',
    why: 'exposed by cookie, tracing-subscriber and others, so it is needed beside chrono',
  },
  { ecosystem: 'cargo', name: 'hyper', why: 'the transport under reqwest and axum' },
  { ecosystem: 'cargo', name: 'sqlx', why: 'a query layer that sea-orm runs on' },
  { ecosystem: 'cargo', name: 'pretty_env_logger', why: 'a wrapper around env_logger' },
  {
    ecosystem: 'cargo',
    name: 'tracing-subscriber',
    why: 'the tracing backend, which coexists with a log backend through tracing-log',
  },
];

/**
 * Whether an ecosystem's manifests can say "test only". Go cannot (go.mod has
 * no dev scope), so a test-runner pair there is unknowable rather than
 * runtime, and that row is skipped.
 */
export function devScopeKnown(ecosystem: DeclaredEcosystem): boolean {
  return ecosystem !== 'go';
}

/**
 * The comparison form of a package name.
 *
 * npm is lowercase already; PyPI compares under PEP 503; crates.io treats `-`
 * and `_` as one; a Go module's major-version suffix (`/v2`, `.v3`) is the
 * same library; Maven coordinates are case-sensitive in theory and lowercase
 * in practice.
 */
export function normalizePackage(ecosystem: DeclaredEcosystem, name: string): string {
  const lower = name.trim().toLowerCase();
  if (ecosystem === 'pypi') return lower.replace(/[-_.]+/g, '-');
  if (ecosystem === 'cargo') return lower.replace(/_/g, '-');
  if (ecosystem === 'go') return lower.replace(/\/v\d+$/, '');
  return lower;
}

/** member lookup: ecosystem -> normalized name -> (category, member). */
const INDEX = new Map<string, { category: DepCategory; member: CategoryMember }>();
for (const category of DEP_CATEGORIES) {
  for (const member of category.members) {
    for (const name of member.names) {
      INDEX.set(`${category.ecosystem}\0${normalizePackage(category.ecosystem, name)}`, {
        category,
        member,
      });
    }
  }
}

export function categoryOf(
  ecosystem: DeclaredEcosystem,
  name: string,
): { category: DepCategory; member: CategoryMember } | null {
  return INDEX.get(`${ecosystem}\0${normalizePackage(ecosystem, name)}`) ?? null;
}
