const http = require('http');
http.get('http://localhost:3100/api/processo/10/peticoes', res => {
  let data = '';
  res.on('data', c => data += c);
  res.on('end', () => {
    const j = JSON.parse(data);
    const pets = j.resumo.ultimas_peticoes;
    const withResp = pets.filter(p => p.resposta_juiz);
    const withDJ = pets.filter(p => p.resposta_datajud);
    const noResp = pets.filter(p => !p.resposta_juiz && !p.resposta_datajud);
    console.log('Proc 10:', j.reclamante);
    console.log('Total peticoes:', pets.length);
    console.log('Com resposta PJe:', withResp.length);
    console.log('Com resposta DataJud:', withDJ.length);
    console.log('Sem resposta:', noResp.length);
    console.log('\n--- Exemplos com resposta ---');
    withResp.slice(0, 3).forEach(p => {
      console.log('\nPet:', p.data, '-', p.titulo);
      console.log('Resp:', p.resposta_juiz.data, '-', p.resposta_juiz.titulo);
      console.log('Reqs:', p.resposta_juiz.requerimentos?.length || 0);
      console.log('Texto (400ch):', (p.resposta_juiz.texto || '').substring(0, 400));
      console.log('Link:', p.resposta_juiz.link || 'sem');
    });
  });
});
