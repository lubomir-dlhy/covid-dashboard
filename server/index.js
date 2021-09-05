const express = require("express");
require("dotenv").config();
const cron = require("node-cron");

const PORT = process.env.PORT || 3078;

const app = express();

const Pool = require("pg").Pool;
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});

const pg = require("pg");
pg.types.setTypeParser(1082, function (stringValue) {
  return new Date(stringValue).toISOString().split("T")[0]; //1082 for date type
});

const cheerio = require("cheerio");
const axios = require("axios");

async function fetchHTML(url) {
  const { data } = await axios.get(url);
  return cheerio.load(data);
}

const getNumberFromComment = ($, comment) => {
  try {
    return parseInt(
      $("*")
        .contents()
        .filter(function () {
          return this.nodeType === 8 && this.nodeValue.includes(comment);
        })[0]
        .nextSibling.nodeValue.replace(/\s/g, "")
    );
  } catch (error) {
    return null;
  }
};

const getNumberFromHeader = ($, identifier) => {
  try {
    return parseInt(
      $("#" + identifier + " div > *.govuk-heading-l")
        .text()
        .replace(/\s/g, "")
    );
  } catch (error) {
    return null;
  }
};

const getNumberFromParagraph = ($, identifier) => {
  try {
    return parseInt(
      $("#" + identifier + " div > p")
        .text()
        .replace(/\s/g, "")
        .match(/-?\d+/)
    );
  } catch (error) {
    return null;
  }
};

const getDateFromBlock = ($, identifier) => {
  try {
    return $("#" + identifier + " div > p")
      .text()
      .split(/ (.*)/)[1]
      .replace(/\./g, "")
      .split(" ")
      .reverse()
      .join("-");
  } catch (error) {
    return null;
  }
};

const blockIDs = {
  pcrTests: "block_5fb76a90e6197",
  pcrPositive: "block_5fb76a90e6199",
  agTests: "block_5fb764f549941",
  agPositive: "block_5fb764f549943",
  hospitalized: "block_5e9f604b47a87",
  hospitalizedConfirmed: "block_5e9f60f747a89",
  deaths: "block_60378d5bc4f89",
  median7day: "block_5ea6e64364d13",
  vaccinatedFirstDose: "block_6007f1bbea5a1",
  vaccinatedSecondDose: "block_6023af801250b",
  date: "block_5e9f629147a8d",
};

app.get("/api", async (req, res) => {
  const startdate = typeof req.query.startdate !== "undefined" ? req.query.startdate : "now()::date - '1 week'::interval";
  const enddate = typeof req.query.enddate !== "undefined" ? req.query.enddate : "now()";

  const query = `
  SELECT 
    *, 
    coalesce(pcr_positive_today+ag_positive_today,pcr_positive_today,ag_positive_today) as pcr_ag_positive
  FROM daily_general
  WHERE date between ${startdate} and ${enddate}
  order by date asc;
  `;

  const result = await pool.query(query);

  data = [];
  if (result.rows.length > 0) {
    data = result.rows;
  }
  return res.json(data);

  const queries = [
    "SELECT * FROM daily_general where date >= now()::date - '1 week'::interval order by date desc;",
    "SELECT * FROM daily_general where date >= (now()::date - '2 week'::interval) and date < (now()::date - '1 week'::interval) order by date desc;",
  ];

  const promises = queries.map(async (query) => {
    const results = await pool.query(query);
    if (results.rows.length > 0) {
      const PcrAgAvg = (results.rows.map((res) => res.pcr_positive_today + res.ag_positive_today).reduce((a, b) => a + b) / results.rows.length).toFixed(0);
      const PcrAvg = (results.rows.map((res) => res.pcr_positive_today).reduce((a, b) => a + b) / results.rows.length).toFixed(0);
      const AgAvg = (results.rows.map((res) => res.ag_positive_today).reduce((a, b) => a + b) / results.rows.length).toFixed(0);
      const PcrTestsAvg = (results.rows.map((res) => res.pcr_tests_today).reduce((a, b) => a + b) / results.rows.length).toFixed(0);
      const AgTestsAvg = (results.rows.map((res) => res.ag_tests_today).reduce((a, b) => a + b) / results.rows.length).toFixed(0);
      const deathsAvg = (results.rows.map((res) => res.deaths_today).reduce((a, b) => a + b) / results.rows.length).toFixed(0);
      const dates = results.rows.map((res) => res.date.toLocaleString());
      const sum14d = await pool.query(
        "SELECT sum(pcr_positive_today) as pcr,sum(ag_positive_today) as ag FROM daily_general where date > $1::date - '2 week'::interval and date <= $1::date limit 14;",
        [dates[0]]
      );

      return {
        PCR_AG_AVERAGE: PcrAgAvg,
        PCR_AVERAGE: PcrAvg,
        AG_AVERAGE: AgAvg,
        PCR_TESTS_AVERAGE: PcrTestsAvg,
        AG_TESTS_AVERAGE: AgTestsAvg,
        DEATHS_AVERAGE: deathsAvg,
        HOSPITALIZED: results.rows[0].hospitalized,
        HOSPITALIZED_TODAY: results.rows[0].hospitalized_change,
        results: results.rows.length,
        latest_date: results.rows[0].date.toLocaleString(),
        dates: dates,
        rawData: {
          pcrP: results.rows.map((res) => res.pcr_positive_today),
          agP: results.rows.map((res) => res.ag_positive_today),
          deaths: results.rows.map((res) => res.deaths_today),
          hosp: results.rows.map((res) => res.hospitalized),
        },
        incidence14d: { pcr: ((sum14d.rows[0].pcr * 100_000) / 5_464_060).toFixed(0), ag: ((sum14d.rows[0].ag * 100_000) / 5_464_060).toFixed(0) },
      };
    }
  });

  const data = await Promise.all(promises);

  res.json(data);
});

app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});

const getKoronaGovData = async () => {
  const $ = await fetchHTML("https://korona.gov.sk/koronavirus-na-slovensku-v-cislach/");
  lastUpdate = getDateFromBlock($, blockIDs.date);
  dbDate = new Date(lastUpdate).toISOString().split("T")[0];
  pcrP = getNumberFromComment($, "koronastats-positives ");
  pcrPT = getNumberFromComment($, "koronastats-positives-delta ");
  pcrT = getNumberFromComment($, "koronastats-lab-tests ");
  pcrTT = getNumberFromComment($, "koronastats-lab-tests-delta ");
  deaths = getNumberFromComment($, "koronastats-deceased ");
  // deathsT = getNumberFromComment($, "koronastats-deceased-delta ");
  deathsT = getNumberFromHeader($, blockIDs.deaths);
  agTT = getNumberFromComment($, "koronastats-ag-tests-delta ");
  agPT = getNumberFromComment($, "koronastats-ag-positives-delta ");
  hosp = getNumberFromComment($, "koronastats-hospitalized ");
  hospT = getNumberFromComment($, "koronastats-hospitalized-delta ");
  vaccine1 = getNumberFromComment($, "koronastats-slovakia_vaccination_dose1_total ");
  vaccine1T = getNumberFromComment($, "koronastats-slovakia_vaccination_dose1_delta ");
  vaccine2 = getNumberFromComment($, "koronastats-slovakia_vaccination_dose2_total ");
  vaccine2T = getNumberFromComment($, "koronastats-slovakia_vaccination_dose2_delta ");

  const query = `INSERT INTO daily_general (date, pcr_positive, pcr_positive_today, pcr_tests_today, deaths, deaths_today, ag_tests_today, ag_positive_today, 
    hospitalized, hospitalized_change, vaccinated1stdose, vaccinated1stdose_today, vaccinated2nddose, vaccinated2nddose_today) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) ON CONFLICT ON CONSTRAINT date_unique DO NOTHING;`;
  const variables = [dbDate, pcrP, pcrPT, pcrTT, deaths, deathsT, agTT, agPT, hosp, hospT, vaccine1, vaccine1T, vaccine2, vaccine2T];
  const result = await pool.query(query, variables);
  console.log(result);
};

//getKoronaGovData();

cron.schedule("*/30 10-12 * * *", () => {
  console.log("UPDATED");
  getKoronaGovData();
});
