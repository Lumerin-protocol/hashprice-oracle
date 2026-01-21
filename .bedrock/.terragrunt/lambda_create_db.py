"""
Lambda function to create GraphNode database in RDS PostgreSQL.
This runs in the VPC and doesn't require local VPN connectivity.
"""

import os
import json
import psycopg2
from psycopg2 import sql


def handler(event, context):
    """
    Create the graphnode database with specific collation settings.
    """
    db_host = os.environ['DB_HOST']
    db_port = int(os.environ['DB_PORT'])
    db_user = os.environ['DB_USER']
    db_password = os.environ['DB_PASSWORD']
    db_name = os.environ['DB_NAME']
    
    print(f"Connecting to PostgreSQL at {db_host}:{db_port}")
    
    try:
        # Connect to postgres database to create the new database
        conn = psycopg2.connect(
            host=db_host,
            port=db_port,
            user=db_user,
            password=db_password,
            database='postgres',
            connect_timeout=10
        )
        
        # Must be in autocommit mode to create databases
        conn.autocommit = True
        cursor = conn.cursor()
        
        # Check if database already exists
        cursor.execute(
            "SELECT 1 FROM pg_database WHERE datname = %s",
            (db_name,)
        )
        exists = cursor.fetchone()
        
        if exists:
            print(f"Database '{db_name}' already exists")
            
            # Verify collation settings
            cursor.execute("""
                SELECT datcollate, datctype 
                FROM pg_database 
                WHERE datname = %s
            """, (db_name,))
            collate, ctype = cursor.fetchone()
            
            if collate == 'C' and ctype == 'C':
                print(f"Database '{db_name}' has correct collation settings")
                response = {
                    'statusCode': 200,
                    'body': json.dumps({
                        'message': f'Database {db_name} already exists with correct settings',
                        'collate': collate,
                        'ctype': ctype
                    })
                }
            else:
                print(f"WARNING: Database '{db_name}' has incorrect collation: {collate}/{ctype}")
                response = {
                    'statusCode': 200,
                    'body': json.dumps({
                        'message': f'Database {db_name} exists but has wrong collation',
                        'collate': collate,
                        'ctype': ctype,
                        'expected': 'C/C'
                    })
                }
        else:
            # Create database with C collation
            print(f"Creating database '{db_name}' with C collation")
            
            # Cannot use parameterized query for CREATE DATABASE
            create_db_query = sql.SQL(
                "CREATE DATABASE {db_name} "
                "WITH OWNER = {owner} "
                "ENCODING = 'UTF8' "
                "LC_COLLATE = 'C' "
                "LC_CTYPE = 'C' "
                "TEMPLATE = template0"
            ).format(
                db_name=sql.Identifier(db_name),
                owner=sql.Identifier(db_user)
            )
            
            cursor.execute(create_db_query)
            print(f"Database '{db_name}' created successfully")
            
            response = {
                'statusCode': 200,
                'body': json.dumps({
                    'message': f'Database {db_name} created successfully',
                    'collate': 'C',
                    'ctype': 'C'
                })
            }
        
        cursor.close()
        conn.close()
        
        return response
        
    except psycopg2.Error as e:
        error_msg = f"PostgreSQL error: {str(e)}"
        print(error_msg)
        return {
            'statusCode': 500,
            'body': json.dumps({
                'error': error_msg
            })
        }
    except Exception as e:
        error_msg = f"Unexpected error: {str(e)}"
        print(error_msg)
        return {
            'statusCode': 500,
            'body': json.dumps({
                'error': error_msg
            })
        }

