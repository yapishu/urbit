import { Text, Col, Row } from '@tlon/indigo-react';
import { Association, GraphNode, TextContent, UrlContent } from '@urbit/api';
import React from 'react';
import { useGroup } from '~/logic/state/group';
import Author from '~/views/components/Author';
import Comments from '~/views/components/Comments';
import { LinkBlockItem } from './LinkBlockItem';

export interface LinkDetailProps {
  node: GraphNode;
  association: Association;
  baseUrl: string;
}

export function LinkDetail(props: LinkDetailProps) {
  const { node, association } = props;
  const group = useGroup(association.group);
  const { post } = node;
  const [{ text: title }] = post.contents as [TextContent, UrlContent];
  return (
    <Row flexDirection={['column', 'column', 'row']} height="100%" width="100%">
      <LinkBlockItem flexGrow={1} border={0} node={node} />
      <Col
        flexShrink={0}
        width={['100%', '100%', '350px']}
        flexGrow={0}
        gapY="4"
        borderLeft="1"
        borderColor="lightGray"
        py="4"
      >
        <Col px="4" gapY="2">
          <Text fontWeight="medium" lineHeight="tall">
            {title}
          </Text>
          <Author
            sigilPadding={4}
            size={24}
            ship={post.author}
            showImage
            date={post['time-sent']}
          />
        </Col>
        <Col
          height="100%"
          overflowY="auto"
          borderTop="1"
          borderTopColor="lightGray"
          p="4"
        >
          <Comments
            association={association}
            comments={node}
            baseUrl={props.baseUrl}
            group={group}
          />
        </Col>
      </Col>
    </Row>
  );
}
