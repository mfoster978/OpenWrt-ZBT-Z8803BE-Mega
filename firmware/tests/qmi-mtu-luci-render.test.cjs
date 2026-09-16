'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const patch = fs.readFileSync(path.join(root, 'firmware/patches/qmodem-mtu-v17.patch'), 'utf8');
const additions = patch.split('\n')
  .filter(line => line.startsWith('+') && !line.startsWith('+++'))
  .map(line => line.slice(1))
  .join('\n');

function loadMtuOption() {
  const renders = [];
  const parses = [];

  function Value() {}
  Value.prototype.render = function(option_index, section_id, in_table) {
    renders.push([option_index, section_id, in_table]);
    return Promise.resolve({ option_index, section_id, in_table });
  };
  Value.prototype.parse = function(section_id) {
    parses.push(section_id);
    return Promise.resolve();
  };

  const option = new Value();
  option.depends = () => {};
  const s = {
    option(type, key, title) {
      assert.equal(type, Value);
      assert.equal(key, 'mtu');
      assert.equal(title, 'Cellular MTU');
      return option;
    }
  };

  new Function('form', 's', '_', 'E', 'var o;\n' + additions)(
    { Value }, s, value => value, tag => ({ tag })
  );

  return { option, renders, parses };
}

test('Cellular MTU render uses LuCI option_index, section_id, in_table signature', async () => {
  const { option, renders } = loadMtuOption();

  const modem1 = await option.render(7, '4_1', false);
  const modem2 = await option.render(8, '2_1', true);
  await option.render(9, 'external_modem', false);

  assert.deepEqual(modem1, { option_index: 7, section_id: '4_1', in_table: false });
  assert.deepEqual(modem2, { option_index: 8, section_id: '2_1', in_table: true });
  assert.deepEqual(renders, [
    [7, '4_1', false],
    [8, '2_1', true]
  ], 'fixed modem rows must call the real Value renderer; unrelated devices stay hidden');
});

test('Cellular MTU parse remains section-id based and skips unrelated devices', async () => {
  const { option, parses } = loadMtuOption();

  await option.parse('4_1');
  await option.parse('2_1');
  await option.parse('external_modem');

  assert.deepEqual(parses, ['4_1', '2_1']);
});
