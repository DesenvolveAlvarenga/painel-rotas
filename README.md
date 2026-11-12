# Painel de Rotas

Sistema para roteirizar entregas, ver os veículos no mapa em tempo real e importar a planilha do seu sistema.

**O que ele faz**
- Cadastro de veículos, com um link pessoal para o celular de cada motorista (GPS em tempo real e botão "Entreguei").
- Busca de endereço: digite, aperte Enter, escolha o resultado e veja a rota pelas ruas a partir do depósito.
- Cadastro de clientes importado de planilha .xls, .xlsx ou .csv (código, nome e endereço). Ao criar uma entrega, digite o código ou o nome e o sistema sugere o cliente, com o endereço já localizado.
- "Otimizar rotas": divide as entregas entre os veículos, ordena as paradas (prioridade alta primeiro) e desenha a rota pelas ruas com horário estimado de chegada.

## Testar no seu computador
1. Instale o Node.js 20 ou mais novo (nodejs.org).
2. Abra um terminal nesta pasta e rode: `npm start`
3. Abra http://localhost:3000
4. Na aba **Frota**, informe o endereço do depósito e cadastre os veículos.

Para conferir o servidor sem internet: `npm test` (usa serviços de mapa simulados).

## Publicar na nuvem (para os motoristas acessarem)
O GPS do celular só funciona em endereço seguro (https), que os serviços de hospedagem abaixo já fornecem.

1. Crie uma conta no GitHub e envie esta pasta para um repositório privado.
2. Crie uma conta em um serviço que rode aplicativos Node.js (por exemplo Render, Railway ou Fly.io) e crie um novo "Web Service" ligado a esse repositório.
3. Comando de início: `npm start` (não há nada para instalar).
4. Configure as variáveis de ambiente:

| Variável | Para quê | Exemplo |
|---|---|---|
| `ADMIN_PASSWORD` | Senha do painel (obrigatória na nuvem). Usuário: qualquer um. | `uma-senha-forte` |
| `CONTACT_EMAIL` | Seu e-mail, exigido pelo serviço gratuito de busca de endereços | `voce@empresa.com.br` |
| `DATA_DIR` | Pasta onde ficam os dados. Aponte para um disco persistente | `/var/data` |
| `GOOGLE_MAPS_KEY` | Opcional. Chave da Geocoding API do Google para localizar clientes com mais precisão | `AIza...` |
| `COUNTRY_CODES` | Limita a busca ao país (padrão `br`) | `br` |

5. **Importante:** sem disco persistente, os dados são apagados a cada atualização do aplicativo. Escolha um plano que ofereça disco e monte-o no caminho de `DATA_DIR`. Confira os preços atuais no site do provedor.
6. Abra o endereço que o provedor gerar, digite a senha e siga o passo 4 da seção anterior. Na aba **Frota**, copie o link de cada veículo e mande para o motorista.

## Clientes e planilha
Na aba **Clientes**, escolha o arquivo. O sistema reconhece sozinho as colunas Código, Cliente, Endereço, Bairro e CEP (e Cidade e UF, se existirem), ignora colunas vazias e mostra como cada cliente vai ficar antes de importar. Só essas informações entram no sistema.

O que ele limpa:
- número de cadastro na frente do nome ("30.201.654 FULANO" vira "FULANO") e CPF/CNPJ no fim do nome;
- vírgulas e pontos soltos no endereço ("RUA X,438", "AV Y. 513"), abreviações (AV, R, PROF, DR, STA) e complementos (APT, LOJA, BLOCO, CASA);
- "S/N" e "SN" (ficam sem número, com posição aproximada da rua); em rodovias o km é descartado;
- CEP com 7 dígitos (perdeu o zero) e CEP incompleto (o estado é deduzido pelos 5 primeiros dígitos).

Como o endereço é localizado: com CEP completo, o sistema descobre cidade e estado pelo CEP (BrasilAPI, com ViaCEP de reserva). Sem CEP completo, usa o estado deduzido do CEP e procura pela rua, número e bairro, descartando resultados de outro estado. Só quando não há CEP nenhum ele usa a "Cidade e estado padrão" da aba Frota; deixe esse campo vazio se os seus clientes são de várias cidades. Cada cliente é localizado uma única vez e o resultado fica salvo.

Clientes que não forem encontrados aparecem numa lista na aba Clientes. Corrija o endereço ou clique em "Marcar no mapa". Fica salvo no cadastro.

Reimportar a planilha atualiza os clientes pelo código, sem duplicar e sem repetir a busca de quem não mudou. Marque "Já incluir todos nas entregas de hoje" só se quiser mandar a lista inteira para a rota.

Para montar a rota do dia, na aba **Entregas** digite o código ou o nome no campo Cliente: as sugestões aparecem, setas e Enter escolhem, e o endereço e a rota até o depósito aparecem na hora.

## Mais precisão nos endereços (opcional): Google
A busca gratuita (OpenStreetMap) erra ou não conhece algumas ruas e números do Brasil. Para melhorar muito a precisão, crie uma chave da API "Geocoding" no Google Cloud e informe na variável `GOOGLE_MAPS_KEY`. O sistema passa a usar o Google para localizar os clientes (com CEP e número) e continua guardando o resultado para não pagar duas vezes. Confira o preço e a cota gratuita atuais no site do Google antes de ativar; a conta exige cartão.

## Limites desta versão
- A busca de endereços e as rotas usam serviços gratuitos do OpenStreetMap. Eles pedem uso moderado (1 busca por segundo, sem busca automática enquanto digita) e não são indicados para volume alto. Localizar 100 clientes leva cerca de 4 minutos (uma única vez, depois fica salvo). Para volume maior ou mais precisão, troque por um serviço pago editando as funções `nominatim` e `osrmRoute` em `server.js`, ou hospede os seus.
- A precisão de endereços com número varia por cidade. Quando o número não é achado, o sistema marca a entrega como "Posição aproximada".
- A ordem das paradas é calculada com distância estimada em linha reta; as distâncias e horários exibidos nas rotas vêm do cálculo pelas ruas.
- Senha única para o painel. Cada motorista acessa só pelo link pessoal; trate o link como senha.
- Os dados ficam em um arquivo no disco. Para várias empresas ou muito volume, o próximo passo seria um banco de dados.
