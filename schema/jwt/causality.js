import jwt from 'jwt-simple';
import {
  GraphQLString,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLEnumType,
} from 'graphql';
import gravity from '../../lib/loaders/gravity';
import { find } from 'lodash';

const { HMAC_SECRET } = process.env;

export default {
  type: GraphQLString,
  description: 'Creates, and authorizes, a JWT custom for Causality',
  args: {
    sale_id: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'The id of the auction to participate in',
    },
    role: {
      type: new GraphQLEnumType({
        name: 'Role',
        values: {
          BIDDER: { value: 'BIDDER' },
          OPERATOR: { value: 'OPERATOR' },
        },
      }),
      description: '',
    },
  },
  resolve: (root, options, { rootValue: { accessToken } }) => {
    return Promise.all([
      gravity.with(accessToken)('me'),
      gravity.with(accessToken)('me/bidders')
    ]).then(([ me, bidders ]) => {
      if (options.role === 'OPERATOR' && me.type !== 'Admin')
        throw new Error('Unauthorized to act as an operator');
      const registered = find(bidders, (b) => b.sale.id === options.sale_id)
      if (options.causality_role === 'BIDDER' && !registered)
        throw new Error('Not registered to bid in this auction')
      const data = {
        sub: 'auctions',
        role: 'bidder',
        userId: me.id,
        saleId: registered.sale._id,
        bidderId: me.paddle_number,
        iat: new Date().getTime()
      };
      return jwt.encode(data, HMAC_SECRET);
    });
  },
};
