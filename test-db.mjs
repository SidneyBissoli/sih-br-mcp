import { getAvailableYears, queryCausas, queryIcsap, rankCsapGroups } from './dist/db/duckdb.js';

async function test() {
  try {
    console.log('1. Testing getAvailableYears...');
    const years = getAvailableYears();
    console.log('   Available years:', years);

    console.log('\n2. Testing queryCausas...');
    const causas = await queryCausas({
      filters: { years: [2024] },
      groupBy: ['uf'],
      metrics: ['n', 'deaths']
    });
    console.log('   Results:', JSON.stringify(causas, null, 2));

    console.log('\n3. Testing queryIcsap...');
    const icsap = await queryIcsap({
      filters: { years: [2024] },
      metrics: ['n', 'n_total']
    });
    console.log('   Results:', JSON.stringify(icsap, null, 2));

    console.log('\n4. Testing rankCsapGroups...');
    const ranking = await rankCsapGroups({
      filters: { years: [2024] },
      metric: 'n',
      limit: 5
    });
    console.log('   Results:', JSON.stringify(ranking, null, 2));

    console.log('\nAll tests passed!');
  } catch (error) {
    console.error('Error:', error.message);
    console.error(error.stack);
  }
}

test();
